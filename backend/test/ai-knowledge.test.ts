import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import JSZip from "jszip";
import sharp from "sharp";
import { aiConfig } from "../src/ai-provider";
import { reserveProviderRequest } from "../src/ai-budget";
import { openDatabase, readDatabase, writeDatabase } from "../src/database";
import { tokenHash } from "../src/auth";
import { ensureRuntimeSchema } from "../src/runtime";
import {
  ensureKnowledgeSchema,
  registerKnowledgeRoutes,
  retrieveKnowledge,
  sourcesStillValid,
  startKnowledgeWorker,
} from "../src/ai-knowledge";
import {
  tokenize,
  splitSections,
  cosineRank,
  mergeCosineRanks,
  parseDocument,
} from "../src/ai-document-worker";

let sql: DatabaseSync,
  server: Server,
  provider: Server,
  base: string,
  stop: (() => void) | undefined;
let providerCalls = 0;
const listen = async (server: Server) => {
  server.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
};
beforeEach(async () => {
  providerCalls = 0;
  sql = openDatabase(":memory:");
  ensureRuntimeSchema(sql);
  ensureKnowledgeSchema(sql);
  for (const [id, role] of [
    ["admin", "admin"],
    ["customer", "user"],
    ["marketing", "admin"],
  ]) {
    sql
      .prepare("INSERT INTO accounts VALUES(?,?,?,?,?,?)")
      .run(id, id, id, role, "synthetic", 1);
    sql
      .prepare("INSERT INTO sessions VALUES(?,?,?)")
      .run(tokenHash(id + "-token"), id, Date.now() + 60000);
  }
  sql
    .prepare("INSERT INTO staff_access VALUES('marketing','operations',1)")
    .run();
  sql.prepare("INSERT INTO staff_access VALUES('admin','owner',1)").run();
  const app = express();
  app.use(express.json({ limit: "15mb" }));
  registerKnowledgeRoutes(app, sql);
  app.use(
    (
      error: Error & { status?: number },
      _req: unknown,
      res: express.Response,
      _next: unknown,
    ) => res.status(error.status ?? 500).json({ error: error.message }),
  );
  server = createServer(app);
  base = await listen(server);
  provider = createServer(async (req, res) => {
    providerCalls++;
    const parts: Buffer[] = [];
    for await (const chunk of req) parts.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(parts).toString());
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/embeddings")
      res.end(
        JSON.stringify({
          data: body.input.map((_text: string, index: number) => ({
            index,
            embedding: [1, 0.5, 0.25],
          })),
        }),
      );
    else if (req.url === "/rerank")
      res.end(
        JSON.stringify({
          results: body.documents
            .map((_text: string, index: number) => ({
              index,
              relevance_score: 1 - index * 0.1,
            }))
            .slice(0, 6),
        }),
      );
    else if (req.url === "/chat/completions")
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: "测试转录：金额 199.00 元；定制商品不支持无理由退货。",
              },
              finish_reason: "stop",
            },
          ],
        }),
      );
    else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  const providerBase = await listen(provider);
  vi.stubEnv("EMBEDDING_BASE_URL", providerBase);
  vi.stubEnv("EMBEDDING_API_KEY", "synthetic");
  vi.stubEnv("EMBEDDING_DIMENSION", "3");
  vi.stubEnv("EMBEDDING_DIMENSIONS", "");
  vi.stubEnv("RERANKER_URL", providerBase + "/rerank");
  vi.stubEnv("RERANKER_BASE_URL", "");
  vi.stubEnv("RERANKER_API_KEY", "synthetic");
  vi.stubEnv("LLM_BASE_URL", providerBase);
  vi.stubEnv("LLM_API_KEY", "synthetic");
});
afterEach(async () => {
  stop?.();
  stop = undefined;
  for (const s of [server, provider]) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
  sql.close();
  vi.unstubAllEnvs();
});
async function request(path: string, body?: unknown, actor = "admin") {
  return fetch(base + "/api/support/documents" + path, {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      Cookie: `shopmate_${actor === "customer" ? "user" : "admin"}=${actor}-token`,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function upload(
  text = "售后政策：七天内可申请售后。定制商品不支持无理由退货。金额 199.00 元。",
) {
  const response = await request("", {
    name: "政策.md",
    contentBase64: Buffer.from(text).toString("base64"),
    requestId: crypto.randomUUID(),
  });
  expect(response.status).toBe(201);
  return (await response.json()).document as {
    id: string;
    version: number;
    status: string;
  };
}
async function awaitStatus(id: string, status: string) {
  await vi.waitFor(
    () =>
      expect(
        (
          sql
            .prepare("SELECT status,error FROM ai_documents WHERE id=?")
            .get(id) as { status: string }
        ).status,
      ).toBe(status),
    { timeout: 10000, interval: 100 },
  );
}
describe("knowledge document lifecycle and retrieval", () => {
  it.each([
    ["AI_KNOWLEDGE_MAX_CHUNKS", "1", "DOCUMENT_CORPUS_CHUNK_LIMIT"],
    ["AI_KNOWLEDGE_MAX_VECTOR_BYTES", "23", "DOCUMENT_CORPUS_VECTOR_LIMIT"],
  ])(
    "preserves published knowledge when retained versions exhaust %s",
    async (setting, limit, error) => {
      const doc = await upload("已发布原政策：定制商品不支持无理由退货。"),
        priorId = `${doc.id}:v1:0`;
      stop = startKnowledgeWorker(sql);
      await awaitStatus(doc.id, "draft");
      expect(
        (
          await request(`/${doc.id}/actions`, {
            action: "publish",
            version: 1,
            requestId: crypto.randomUUID(),
          })
        ).status,
      ).toBe(200);
      const callsBefore = providerCalls;
      vi.stubEnv(setting, limit);
      expect(
        (
          await request(`/${doc.id}/actions`, {
            action: "save",
            version: 1,
            requestId: crypto.randomUUID(),
            text: "待审核新政策：定制商品先转人工。",
          })
        ).status,
      ).toBe(200);
      await awaitStatus(doc.id, "failed");
      expect(
        sql
          .prepare(
            "SELECT published_version,error FROM ai_documents WHERE id=?",
          )
          .get(doc.id),
      ).toEqual({ published_version: 1, error });
      expect(
        sql
          .prepare(
            "SELECT count(*) n FROM ai_knowledge_chunks WHERE document_id=?",
          )
          .get(doc.id)?.n,
      ).toBe(1);
      expect(
        sql
          .prepare("SELECT text FROM ai_knowledge_chunks WHERE id=?")
          .get(priorId)?.text,
      ).toContain("不支持无理由退货");
      expect(providerCalls).toBe(callsBefore);
      expect(
        sourcesStillValid(sql, [
          {
            id: priorId,
            documentId: doc.id,
            version: 1,
            title: "政策",
            text: "原政策",
          },
        ]),
      ).toBe(true);
    },
  );

  it("accounts child calls before indexing completes using the persistent provider budget", async () => {
    vi.stubEnv("AI_DAILY_PROVIDER_CALLS", "1");
    const doc = await upload("第一段政策。" + "甲".repeat(9000));
    stop = startKnowledgeWorker(sql);
    await awaitStatus(doc.id, "failed");
    expect(
      sql.prepare("SELECT error FROM ai_documents WHERE id=?").get(doc.id)
        ?.error,
    ).toBe("AI_PROVIDER_BUDGET_EXHAUSTED");
    expect(providerCalls).toBe(1);
    expect(
      sql.prepare("SELECT used FROM ai_daily_usage WHERE kind='provider'").get()
        ?.used,
    ).toBe(1);
    expect(
      sql
        .prepare(
          "SELECT count(*) n FROM ai_knowledge_chunks WHERE document_id=?",
        )
        .get(doc.id)?.n,
    ).toBe(0);
  });
  it("reports database budget failures separately from exhausted provider quota", async () => {
    reserveProviderRequest(sql);
    sql.exec(`CREATE TRIGGER reject_budget BEFORE INSERT ON ai_daily_usage
      WHEN NEW.kind='provider' BEGIN SELECT RAISE(ABORT,'synthetic private database failure'); END`);
    const doc = await upload();
    stop = startKnowledgeWorker(sql);
    await awaitStatus(doc.id, "failed");
    expect(
      sql.prepare("SELECT error FROM ai_documents WHERE id=?").get(doc.id)
        ?.error,
    ).toBe("AI_PROVIDER_BUDGET_UNAVAILABLE");
    expect(providerCalls).toBe(0);
  });

  it("enforces support role, download authentication, format and upload limits", async () => {
    expect((await request("", undefined, "customer")).status).toBe(401);
    expect((await request("", undefined, "marketing")).status).toBe(403);
    expect((await fetch(base + "/api/support/documents")).status).toBe(401);
    expect(
      (
        await request("", {
          name: "../policy.txt",
          contentBase64: "YQ==",
          requestId: crypto.randomUUID(),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request("", {
          name: "policy.exe",
          contentBase64: "YQ==",
          requestId: crypto.randomUUID(),
        })
      ).status,
    ).toBe(400);
    const doc = await upload();
    expect(
      (await request(`/${doc.id}/file`, undefined, "customer")).status,
    ).toBe(401);
    expect(await (await request(`/${doc.id}/file`)).text()).toContain("不支持");
  });
  it("requires indexed manual publish, retains prior version while editing and retires sources on disable/delete", async () => {
    const doc = await upload();
    stop = startKnowledgeWorker(sql);
    await awaitStatus(doc.id, "draft");
    expect(
      (await retrieveKnowledge(sql, "定制商品退货")).sources.some(
        (s) => s.documentId === doc.id,
      ),
    ).toBe(false);
    const publish = {
      action: "publish",
      version: 1,
      requestId: crypto.randomUUID(),
    };
    expect((await request(`/${doc.id}/actions`, publish)).status).toBe(200);
    const result = await retrieveKnowledge(sql, "定制商品退货");
    expect(result.degraded).toEqual([]);
    expect(result.sources.find((s) => s.documentId === doc.id)?.text).toContain(
      "不支持",
    );
    expect(sourcesStillValid(sql, result.sources)).toBe(true);
    const edited = await request(`/${doc.id}/actions`, {
      action: "save",
      version: 1,
      requestId: crypto.randomUUID(),
      text: "新版政策：定制商品需要先人工审核，不自动退款。",
    });
    expect(edited.status).toBe(200);
    expect((await edited.json()).document.version).toBe(2);
    expect(sourcesStillValid(sql, result.sources)).toBe(true);
    expect(
      (
        await request(`/${doc.id}/actions`, {
          action: "publish",
          version: 1,
          requestId: crypto.randomUUID(),
        })
      ).status,
    ).toBe(409);
    await awaitStatus(doc.id, "draft");
    expect(
      (
        await request(`/${doc.id}/actions`, {
          action: "publish",
          version: 2,
          requestId: crypto.randomUUID(),
        })
      ).status,
    ).toBe(200);
    expect(sourcesStillValid(sql, result.sources)).toBe(false);
    const updated = await retrieveKnowledge(sql, "定制商品");
    expect(updated.sources[0]?.version).toBe(2);
    const disable = {
      action: "disable",
      version: 2,
      requestId: crypto.randomUUID(),
    };
    expect((await request(`/${doc.id}/actions`, disable)).status).toBe(200);
    expect((await request(`/${doc.id}/actions`, disable)).status).toBe(200); // idempotent replay, despite version increment
    expect(sourcesStillValid(sql, updated.sources)).toBe(false);
    expect(
      (await retrieveKnowledge(sql, "定制商品")).sources.some(
        (s) => s.documentId === doc.id,
      ),
    ).toBe(false);
    expect(
      (
        await request(`/${doc.id}/actions`, {
          action: "delete",
          version: 3,
          requestId: crypto.randomUUID(),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        sql
          .prepare(
            "SELECT count(*) n FROM ai_knowledge_chunks WHERE document_id=?",
          )
          .get(doc.id) as { n: number }
      ).n,
    ).toBe(0);
  });
  it("indexes changed FAQ immediately and invalidates old citations on edit or disable", async () => {
    const db = readDatabase(sql);
    db.faqs = [
      {
        id: "faq-test",
        question: "保修服务",
        answer: "保修一年，不支持自动延保。",
        keywords: ["保修"],
        active: true,
      },
    ];
    writeDatabase(sql, db);
    const first = await retrieveKnowledge(sql, "保修服务");
    expect(first.sources[0]?.text).toContain("一年");
    const updated = readDatabase(sql);
    updated.faqs[0]!.answer = "保修两年。";
    writeDatabase(sql, updated);
    expect(sourcesStillValid(sql, first.sources)).toBe(false);
    expect((await retrieveKnowledge(sql, "保修")).sources[0]?.text).toContain(
      "两年",
    );
    const disabled = readDatabase(sql);
    disabled.faqs[0]!.active = false;
    writeDatabase(sql, disabled);
    expect((await retrieveKnowledge(sql, "保修")).sources).toEqual([]);
  });
  it("fails recognition/index jobs without publishing and supports an explicit retry", async () => {
    const doc = await upload("\u0000bad binary");
    stop = startKnowledgeWorker(sql);
    await awaitStatus(doc.id, "failed");
    const failed = (await (await request(`/${doc.id}`)).json()).document;
    expect(failed.error).toBe("DOCUMENT_INVALID_TEXT");
    expect(failed.publishedVersion).toBeNull();
    expect(
      (
        await request(`/${doc.id}/actions`, {
          action: "publish",
          version: 1,
          requestId: crypto.randomUUID(),
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(`/${doc.id}/actions`, {
          action: "retry",
          version: 1,
          requestId: crypto.randomUUID(),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        sql
          .prepare("SELECT version FROM ai_documents WHERE id=?")
          .get(doc.id) as { version: number }
      ).version,
    ).toBe(2);
  });
  it("degrades embedding and reranker to live keyword sources", async () => {
    const doc = await upload();
    stop = startKnowledgeWorker(sql);
    await awaitStatus(doc.id, "draft");
    await request(`/${doc.id}/actions`, {
      action: "publish",
      version: 1,
      requestId: crypto.randomUUID(),
    });
    vi.stubEnv("EMBEDDING_API_KEY", "");
    vi.stubEnv("RERANKER_API_KEY", "");
    const result = await retrieveKnowledge(sql, "售后政策");
    expect(result.sources.some((s) => s.documentId === doc.id)).toBe(true);
    expect(result.degraded).toContain("embedding_unavailable_keyword_only");
    expect(result.degraded).toContain("reranker_unavailable_fusion_order");
  });
});

describe("bounded document processing", () => {
  it("retrieves a semantic winner beyond the first vector batch", async () => {
    const id = "batched-document",
      at = new Date().toISOString();
    sql
      .prepare(
        `INSERT INTO ai_documents(id,name,mime,raw,bytes,status,version,published_version,created_at,updated_at)
      VALUES(?,?,'text/plain',?,1,'published',1,1,?,?)`,
      )
      .run(id, "批量合成.txt", Buffer.from("x"), at, at);
    const insert = sql.prepare(
      "INSERT INTO ai_knowledge_chunks VALUES(?,?,1,?,1,1,?,?,3)",
    );
    for (let i = 0; i < 130; i++) {
      const chunkId = `${id}-${String(i).padStart(3, "0")}`,
        text = `独立条目${i}，材料说明。`,
        vector = Buffer.from(
          new Float32Array(i === 129 ? [1, 0.5, 0.25] : [0, 1, 0]).buffer,
        );
      insert.run(chunkId, id, text, vector, aiConfig().embeddingModel);
      sql
        .prepare("INSERT INTO ai_knowledge_fts(chunk_id,tokens) VALUES(?,?)")
        .run(chunkId, tokenize(text));
    }
    const result = await retrieveKnowledge(sql, "跨批向量检索");
    expect(result.degraded).toEqual([]);
    expect(result.sources[0]?.id).toBe(`${id}-129`);
    expect(result.sources).toHaveLength(6);
  });

  it("merges semantic top candidates across bounded batches without retaining every vector", () => {
    const first = Array.from({ length: 20 }, (_, i) => ({
      id: `first-${i}`,
      score: i / 100,
    }));
    const merged = mergeCosineRanks(first, [
      { id: "later-best", score: 0.99 },
      { id: "discarded", score: -1 },
    ]);
    expect(merged).toHaveLength(20);
    expect(merged[0]?.id).toBe("later-best");
    expect(merged.some((row) => row.id === "discarded")).toBe(false);
  });
  it("packs short OCR paragraphs with their entity, amount, warranty and prohibition on the same page", () => {
    const chunks = splitSections([
      {
        page: 1,
        text: "合成保温杯\n\n容量 420 毫升。\n\n合成质保期限 17 天。\n\n禁止机洗。",
      },
      { page: 2, paragraph: 8, text: "第二页是独立来源。" },
    ]);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({ page: 1, paragraph: 1 });
    for (const fact of ["合成保温杯", "420", "17", "禁止机洗"])
      expect(chunks[0]?.text).toContain(fact);
    expect(chunks[1]).toMatchObject({
      page: 2,
      paragraph: 8,
      text: "第二页是独立来源。",
    });
  });
  it("deduplicates format copies before retrieval cutoffs so distinct facts retain context slots", async () => {
    const duplicate = "合成保温杯容量 420 毫升。",
      distinct = "合成保温杯质保期限 17 天，禁止机洗。";
    const vector = Buffer.from(new Float32Array([1, 0.5, 0.25]).buffer);
    for (let i = 0; i < 26; i++) {
      const id = `doc-copy-${i}`,
        text = i === 25 ? distinct : duplicate,
        chunkId = `${id}:v1:0`;
      sql
        .prepare(
          `INSERT INTO ai_documents(id,name,mime,raw,bytes,status,version,published_version,text,sections,created_at,updated_at)
        VALUES(?,?,?, ?,1,'published',1,1,?,'[]',?,?)`,
        )
        .run(
          id,
          `copy-${i}.txt`,
          "text/plain",
          Buffer.from("x"),
          text,
          new Date().toISOString(),
          new Date().toISOString(),
        );
      sql
        .prepare("INSERT INTO ai_knowledge_chunks VALUES(?,?,1,?,1,1,?,?,3)")
        .run(chunkId, id, text, vector, aiConfig().embeddingModel);
      sql
        .prepare("INSERT INTO ai_knowledge_fts(chunk_id,tokens) VALUES(?,?)")
        .run(chunkId, tokenize(text));
    }
    const result = await retrieveKnowledge(sql, "合成保温杯容量和质保要求");
    expect(result.sources.filter((s) => s.text === duplicate)).toHaveLength(1);
    expect(result.sources.some((s) => s.text === distinct)).toBe(true);
    expect(new Set(result.sources.map((s) => s.text)).size).toBe(
      result.sources.length,
    );
    expect(result.sources).toHaveLength(2);
  });
  it("segments Chinese, preserves page/paragraph and computes cosine outside the API", () => {
    expect(tokenize("定制商品不支持退货")).toContain("不支");
    const chunks = splitSections([
      { page: 2, text: "甲".repeat(1200) + "\n\n否定：不支持退款。" },
    ]);
    expect(chunks[0]?.text.length).toBe(600);
    expect(chunks[1]?.text.length).toBe(600);
    expect(chunks.at(-1)).toMatchObject({ page: 2, paragraph: 1 });
    expect(chunks.at(-1)?.text).toContain("不支持退款");
    const vector = (values: number[]) =>
      Buffer.from(new Float32Array(values).buffer);
    expect(
      cosineRank(
        [1, 0],
        [
          { id: "wrong", vector: vector([0, 1]) },
          { id: "right", vector: vector([1, 0]) },
        ],
      )[0]?.id,
    ).toBe("right");
  });
  it("rejects invalid archives, encrypted/invalid PDF signatures and unsupported formats", async () => {
    await expect(
      parseDocument("bad.docx", Buffer.from("PK bad")),
    ).rejects.toThrow("DOCUMENT_INVALID_DOCX");
    await expect(
      parseDocument("bad.pdf", Buffer.from("not pdf")),
    ).rejects.toThrow("DOCUMENT_INVALID_PDF");
    await expect(parseDocument("bad.exe", Buffer.from("fake"))).rejects.toThrow(
      "DOCUMENT_UNSUPPORTED_FORMAT",
    );
  });
  it("extracts TXT, Markdown, DOCX and sends decoded PNG/JPEG/WebP to the vision protocol", async () => {
    const sentence = "金额 199.00 元；定制商品不支持无理由退货。";
    for (const ext of ["txt", "md"])
      expect(
        (await parseDocument(`policy.${ext}`, Buffer.from(sentence)))[0]?.text,
      ).toBe(sentence);
    const zip = new JSZip();
    zip.file(
      "[Content_Types].xml",
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    );
    zip.file(
      "_rels/.rels",
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    );
    zip.file(
      "word/document.xml",
      `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${sentence}</w:t></w:r></w:p></w:body></w:document>`,
    );
    const docx = await parseDocument(
      "policy.docx",
      await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
    );
    expect(docx[0]?.text).toContain(sentence);
    for (const format of ["png", "jpeg", "webp"] as const) {
      const bytes = await sharp({
        create: { width: 30, height: 20, channels: 3, background: "white" },
      })
        .toFormat(format)
        .toBuffer();
      const result = await parseDocument(`scan.${format}`, bytes);
      expect(result[0]).toMatchObject({
        page: 1,
        text: expect.stringContaining("不支持"),
      });
      if (format === "png")
        await expect(parseDocument("mismatch.jpg", bytes)).rejects.toThrow(
          "DOCUMENT_IMAGE_TYPE_MISMATCH",
        );
    }
  });
  it.skipIf(
    process.platform === "win32" &&
      !!spawnSync("pdftotext", ["-v"], { windowsHide: true }).error,
  )(
    "extracts text PDF and rasterizes scanned PDF with the full Poppler installation",
    async () => {
      // A real minimal PDF exercises Poppler extraction and rasterization. Vision itself is mocked.
      function pdf(content: string) {
        const objects = [
          "<< /Type /Catalog /Pages 2 0 R >>",
          "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
          "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
          "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
          `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
        ];
        let result = "%PDF-1.4\n",
          offsets = [0];
        for (let i = 0; i < objects.length; i++) {
          offsets.push(Buffer.byteLength(result));
          result += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
        }
        const xref = Buffer.byteLength(result);
        result += `xref\n0 6\n0000000000 65535 f \n${offsets
          .slice(1)
          .map((v) => `${String(v).padStart(10, "0")} 00000 n \n`)
          .join(
            "",
          )}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
        return Buffer.from(result);
      }
      const extracted = await parseDocument(
        "text.pdf",
        pdf(
          "BT /F1 12 Tf 20 150 Td (Policy: custom goods are NOT returnable. Price 199.00 yuan.) Tj ET",
        ),
      );
      expect(extracted[0]).toMatchObject({
        page: 1,
        text: expect.stringContaining("NOT returnable"),
      });
      const scanned = await parseDocument(
        "scan.pdf",
        pdf("0.5 g 20 20 200 100 re f"),
      );
      expect(scanned[0]).toMatchObject({
        page: 1,
        text: expect.stringContaining("199.00"),
      });
    },
  );
});
