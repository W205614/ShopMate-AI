import type { Express } from "express";
import type { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { fork, type ChildProcess, type Serializable } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findSession, HttpError } from "./auth";
import { demand } from "./permissions";
import { transaction } from "./database";
import { aiConfig, embed, rerank } from "./ai-provider";
import {
  tokenize,
  splitSections,
  type DocumentSection,
  type KnowledgeChunk,
} from "./ai-document-worker";

export interface KnowledgeSource {
  id: string;
  title: string;
  text: string;
  page?: number;
  paragraph?: number;
  documentId?: string;
  version?: number;
}
interface DocumentRow {
  id: string;
  name: string;
  mime: string;
  raw: Uint8Array;
  bytes: number;
  status: string;
  version: number;
  published_version: number | null;
  text: string;
  sections: string;
  error: string | null;
  page_count: number;
  created_at: string;
  updated_at: string;
}
const maxFile = 10 * 1024 * 1024;
const mimes: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};
const timestamp = () => new Date().toISOString();
const hash = (s: string | Buffer) =>
  createHash("sha256").update(s).digest("hex");
const faqSourceId = (faq: { id: string; question: string; answer: string }) =>
  `faq:${faq.id}:${hash(faq.question + "\0" + faq.answer).slice(0, 16)}`;
const metadata = (row: DocumentRow, full = true) => ({
  id: row.id,
  name: row.name,
  bytes: row.bytes,
  status: row.status,
  version: row.version,
  publishedVersion: row.published_version,
  error: row.error,
  pageCount: row.page_count,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  ...(full
    ? {
        text: row.text,
        sections: JSON.parse(row.sections) as DocumentSection[],
      }
    : {}),
});
const getDocument = (sql: DatabaseSync, id: string) =>
  sql.prepare("SELECT * FROM ai_documents WHERE id=?").get(id) as unknown as
    DocumentRow | undefined;
function needDocument(sql: DatabaseSync, id: string) {
  const row = getDocument(sql, id);
  if (!row) throw new HttpError(404, "文档不存在");
  return row;
}

export function ensureKnowledgeSchema(sql: DatabaseSync) {
  sql.exec(`CREATE TABLE IF NOT EXISTS ai_documents (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, mime TEXT NOT NULL, raw BLOB NOT NULL,
    bytes INTEGER NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
    published_version INTEGER, text TEXT NOT NULL DEFAULT '', sections TEXT NOT NULL DEFAULT '[]',
    error TEXT, page_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ai_knowledge_chunks (
      id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES ai_documents(id) ON DELETE CASCADE,
      version INTEGER NOT NULL, text TEXT NOT NULL, page INTEGER, paragraph INTEGER,
      vector BLOB NOT NULL, model TEXT NOT NULL, dimensions INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS ai_knowledge_chunks_document ON ai_knowledge_chunks(document_id,version);
    CREATE VIRTUAL TABLE IF NOT EXISTS ai_knowledge_fts USING fts5(chunk_id UNINDEXED,tokens,tokenize='unicode61');
    CREATE TABLE IF NOT EXISTS ai_knowledge_faqs (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ai_knowledge_requests (
      actor_id TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL,
      created_at TEXT NOT NULL, PRIMARY KEY(actor_id,request_id));
    CREATE TRIGGER IF NOT EXISTS ai_knowledge_chunk_delete AFTER DELETE ON ai_knowledge_chunks BEGIN
      DELETE FROM ai_knowledge_fts WHERE chunk_id=OLD.id; END;`);
  syncFaqIndex(sql);
}

function faqs(sql: DatabaseSync): {
  id: string;
  question: string;
  answer: string;
  keywords: string[];
  active: boolean;
}[] {
  if (
    !sql
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='biz_faqs'",
      )
      .get()
  )
    return [];
  return (
    sql.prepare("SELECT data FROM biz_faqs WHERE active=1").all() as {
      data: string;
    }[]
  ).map((r) => JSON.parse(r.data));
}

/** Also runs at retrieval so FAQ changes are immediately visible without an async reindex race. */
export function syncFaqIndex(sql: DatabaseSync) {
  const active = faqs(sql),
    ids = new Set(active.map((f) => f.id));
  for (const old of sql
    .prepare("SELECT id,fingerprint FROM ai_knowledge_faqs")
    .all() as { id: string; fingerprint: string }[]) {
    if (!ids.has(old.id)) {
      sql
        .prepare("DELETE FROM ai_knowledge_fts WHERE chunk_id=?")
        .run(old.fingerprint);
      sql.prepare("DELETE FROM ai_knowledge_faqs WHERE id=?").run(old.id);
    }
  }
  for (const faq of active) {
    const fingerprint = faqSourceId(faq);
    const old = sql
      .prepare("SELECT fingerprint FROM ai_knowledge_faqs WHERE id=?")
      .get(faq.id) as { fingerprint: string } | undefined;
    if (old?.fingerprint === fingerprint) continue;
    if (old)
      sql
        .prepare("DELETE FROM ai_knowledge_fts WHERE chunk_id=?")
        .run(old.fingerprint);
    sql
      .prepare("INSERT INTO ai_knowledge_fts(chunk_id,tokens) VALUES(?,?)")
      .run(
        fingerprint,
        tokenize(`${faq.question} ${faq.answer} ${faq.keywords.join(" ")}`),
      );
    sql
      .prepare("INSERT OR REPLACE INTO ai_knowledge_faqs VALUES(?,?)")
      .run(faq.id, fingerprint);
  }
}

function mutation(
  sql: DatabaseSync,
  actor: string,
  requestId: unknown,
  fingerprint: string,
  action: () => unknown,
) {
  if (
    typeof requestId !== "string" ||
    !/^[a-zA-Z0-9_-]{8,128}$/.test(requestId)
  )
    throw new HttpError(400, "请提供有效的请求编号");
  return transaction(sql, () => {
    const old = sql
      .prepare(
        "SELECT fingerprint,result FROM ai_knowledge_requests WHERE actor_id=? AND request_id=?",
      )
      .get(actor, requestId) as
      { fingerprint: string; result: string } | undefined;
    if (old) {
      if (old.fingerprint !== fingerprint)
        throw new HttpError(409, "请求编号已用于其他操作");
      return JSON.parse(old.result);
    }
    const result = action();
    sql
      .prepare("INSERT INTO ai_knowledge_requests VALUES(?,?,?,?,?)")
      .run(actor, requestId, fingerprint, JSON.stringify(result), timestamp());
    return result;
  });
}

export function registerKnowledgeRoutes(
  app: Express,
  sql: DatabaseSync,
  _config?: unknown,
) {
  ensureKnowledgeSchema(sql);
  app.use("/api/support/documents", (req, _res, next) => {
    try {
      demand(findSession(sql, req, "admin"), "support");
      next();
    } catch (e) {
      next(e);
    }
  });
  app.get("/api/support/documents", (_req, res) => {
    const rows = sql
      .prepare(
        "SELECT id,name,mime,bytes,status,version,published_version,error,page_count,created_at,updated_at FROM ai_documents ORDER BY created_at DESC,id DESC",
      )
      .all() as unknown as DocumentRow[];
    res.json({ documents: rows.map((r) => metadata(r, false)) });
  });
  app.post("/api/support/documents", (req, res) => {
    const { name, contentBase64, requestId } = req.body ?? {};
    if (
      typeof name !== "string" ||
      name.length > 180 ||
      /[\\/\x00-\x1f]/.test(name) ||
      !mimes[name.split(".").pop()?.toLowerCase() ?? ""]
    )
      throw new HttpError(400, "文件名或格式不支持");
    if (
      typeof contentBase64 !== "string" ||
      !contentBase64.length ||
      contentBase64.length > Math.ceil(maxFile / 3) * 4 ||
      contentBase64.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(contentBase64)
    )
      throw new HttpError(400, "文件编码无效或超过 10 MiB");
    const raw = Buffer.from(contentBase64, "base64");
    if (!raw.length || raw.length > maxFile)
      throw new HttpError(400, "文件为空或超过 10 MiB");
    const actor = findSession(sql, req, "admin")!.id;
    const result = mutation(
      sql,
      actor,
      requestId,
      hash(JSON.stringify(["upload", name, hash(raw)])),
      () => {
        const totals = sql
          .prepare(
            "SELECT count(*) n,COALESCE(sum(bytes),0) bytes FROM ai_documents",
          )
          .get() as { n: number; bytes: number };
        if (totals.n >= 300 || totals.bytes + raw.length > 256 * 1024 * 1024)
          throw new HttpError(409, "知识库文档数量或总文件容量已达上限");
        const id = `doc-${randomUUID()}`,
          now = timestamp();
        sql
          .prepare(
            "INSERT INTO ai_documents(id,name,mime,raw,bytes,status,created_at,updated_at) VALUES(?,?,?,?,?,'queued',?,?)",
          )
          .run(
            id,
            name,
            mimes[name.split(".").pop()!.toLowerCase()]!,
            raw,
            raw.length,
            now,
            now,
          );
        return { document: metadata(needDocument(sql, id)) };
      },
    );
    res.status(201).json(result);
  });
  app.get("/api/support/documents/:id", (req, res) =>
    res.json({
      document: metadata(needDocument(sql, req.params.id as string)),
    }),
  );
  app.get("/api/support/documents/:id/file", (req, res) => {
    const row = needDocument(sql, req.params.id as string);
    res.setHeader("Content-Type", row.mime);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(row.name)}`,
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.send(Buffer.from(row.raw));
  });
  app.post("/api/support/documents/:id/actions", (req, res) => {
    const { action, version, requestId, text } = req.body ?? {},
      documentId = req.params.id as string;
    if (
      !["save", "publish", "disable", "delete", "retry"].includes(action) ||
      !Number.isSafeInteger(version)
    )
      throw new HttpError(400, "文档操作或版本无效");
    if (
      action === "save" &&
      (typeof text !== "string" || !text.trim() || text.length > 1_000_000)
    )
      throw new HttpError(400, "请填写不超过一百万字的有效正文");
    const actor = findSession(sql, req, "admin")!.id;
    res.json(
      mutation(
        sql,
        actor,
        requestId,
        hash(JSON.stringify([documentId, action, version, text])),
        () => {
          const row = needDocument(sql, documentId);
          if (row.version !== version)
            throw new HttpError(409, "文档已更新，请刷新后重试");
          if (action === "delete") {
            sql.prepare("DELETE FROM ai_documents WHERE id=?").run(documentId);
            return { document: { id: documentId, status: "deleted" } };
          }
          if (action === "disable")
            sql
              .prepare(
                "UPDATE ai_documents SET published_version=NULL,status='disabled',version=version+1,error=NULL,updated_at=? WHERE id=?",
              )
              .run(timestamp(), documentId);
          if (action === "publish") {
            if (
              row.status !== "draft" ||
              !sql
                .prepare(
                  "SELECT 1 FROM ai_knowledge_chunks WHERE document_id=? AND version=?",
                )
                .get(documentId, row.version)
            )
              throw new HttpError(409, "只能发布已成功识别并完成索引的草稿");
            sql
              .prepare(
                "UPDATE ai_documents SET published_version=version,status='published',updated_at=? WHERE id=?",
              )
              .run(timestamp(), documentId);
            sql
              .prepare(
                "DELETE FROM ai_knowledge_chunks WHERE document_id=? AND version<>?",
              )
              .run(documentId, row.version);
          }
          if (action === "save") {
            // Editing invalidates the worker version, but the previous published version remains available.
            sql
              .prepare(
                "DELETE FROM ai_knowledge_chunks WHERE document_id=? AND version<>COALESCE(?,-1)",
              )
              .run(documentId, row.published_version);
            sql
              .prepare(
                "UPDATE ai_documents SET text=?,sections=?,version=version+1,status='queued',error=NULL,updated_at=? WHERE id=?",
              )
              .run(
                text.trim(),
                JSON.stringify([{ text: text.trim() }]),
                timestamp(),
                documentId,
              );
          }
          if (action === "retry") {
            if (!["failed", "disabled"].includes(row.status))
              throw new HttpError(409, "此文档无需重试");
            sql
              .prepare(
                "DELETE FROM ai_knowledge_chunks WHERE document_id=? AND version<>COALESCE(?,-1)",
              )
              .run(documentId, row.published_version);
            sql
              .prepare(
                "UPDATE ai_documents SET version=version+1,status='queued',error=NULL,updated_at=? WHERE id=?",
              )
              .run(timestamp(), documentId);
          }
          return { document: metadata(needDocument(sql, documentId)) };
        },
      ),
    );
  });
}

const workerChildren = new Set<ChildProcess>();
async function runWorker<T>(
  input: unknown,
  signal?: AbortSignal,
  progress?: (sections: DocumentSection[]) => void,
  timeoutMs = 1200000,
): Promise<T> {
  if (signal?.aborted) throw new Error("KNOWLEDGE_CANCELLED");
  const temporary = await mkdtemp(join(tmpdir(), "shopmate-ai-worker-"));
  if (signal?.aborted) {
    await rm(temporary, { recursive: true, force: true });
    throw new Error("KNOWLEDGE_CANCELLED");
  }
  const env: NodeJS.ProcessEnv = {
    AI_DOCUMENT_WORKER: "1",
    AI_DOCUMENT_TEMP: temporary,
  };
  for (const [key, value] of Object.entries(process.env))
    if (
      [
        "PATH",
        "Path",
        "TZ",
        "TEMP",
        "TMP",
        "SystemRoot",
        "SEND_EMBEDDING_DIMENSIONS",
      ].includes(key) ||
      /^(LLM_|EMBEDDING_|RERANKER_|AI_PROVIDER_TIMEOUT_MS$)/.test(key)
    )
      env[key] = value;
  const child = fork(
    fileURLToPath(new URL("./ai-document-worker.ts", import.meta.url)),
    [],
    {
      execArgv: [
        "--import",
        import.meta.resolve("tsx"),
        "--max-old-space-size=256",
        "--max-semi-space-size=16",
      ],
      env,
      serialization: "advanced",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    },
  );
  workerChildren.add(child);
  child.once("exit", () => {
    void rm(temporary, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    }).catch(() => {});
  });
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, result?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      workerChildren.delete(child);
      if (error) {
        child.kill("SIGTERM");
        const kill = setTimeout(() => child.kill("SIGKILL"), 1500);
        kill.unref();
        child.once("exit", () => clearTimeout(kill));
      }
      if (error) reject(error);
      else resolve(result!);
    };
    const cancel = () => finish(new Error("KNOWLEDGE_CANCELLED"));
    const timer = setTimeout(
      () => finish(new Error("DOCUMENT_TIMEOUT")),
      timeoutMs,
    );
    timer.unref();
    signal?.addEventListener("abort", cancel, { once: true });
    child.on("message", (raw: unknown) => {
      const data = raw as {
        progress?: string;
        sections?: DocumentSection[];
        result?: T;
        error?: string;
      };
      if (data.progress && data.sections) {
        try {
          progress?.(data.sections);
        } catch {
          finish(new Error("DOCUMENT_CANCELLED"));
        }
      }
      if (data.error) finish(new Error(data.error));
      else if ("result" in data) finish(undefined, data.result);
    });
    child.once("error", () => finish(new Error("DOCUMENT_WORKER_FAILED")));
    child.once("exit", () => finish(new Error("DOCUMENT_WORKER_FAILED")));
    child.send(input as Serializable, (error) => {
      if (error) finish(new Error("DOCUMENT_WORKER_FAILED"));
    });
  });
}

export function startKnowledgeWorker(sql: DatabaseSync): () => void {
  ensureKnowledgeSchema(sql);
  // One API writer owns the database. A previous process may have stopped between stages.
  sql
    .prepare(
      "UPDATE ai_documents SET status='queued' WHERE status IN ('extracting','indexing')",
    )
    .run();
  let stopped = false,
    busy = false;
  const abort = new AbortController();
  const poll = async () => {
    if (stopped || busy) return;
    const row = sql
      .prepare(
        "SELECT * FROM ai_documents WHERE status='queued' ORDER BY created_at,id LIMIT 1",
      )
      .get() as unknown as DocumentRow | undefined;
    if (!row) return;
    busy = true;
    const setStatus = sql.prepare(
      "UPDATE ai_documents SET status=?,updated_at=? WHERE id=? AND version=? AND status IN ('queued','extracting','indexing')",
    );
    setStatus.run(
      row.text ? "indexing" : "extracting",
      timestamp(),
      row.id,
      row.version,
    );
    try {
      const result = await runWorker<{
        sections: DocumentSection[];
        chunks: KnowledgeChunk[];
      }>(
        {
          name: row.name,
          raw: Buffer.from(row.raw),
          ...(row.text ? { sections: JSON.parse(row.sections) } : {}),
          type: "ingest",
        },
        abort.signal,
        (sections) => {
          const live = getDocument(sql, row.id);
          if (
            !live ||
            live.version !== row.version ||
            !["extracting", "indexing"].includes(live.status)
          )
            throw new Error("DOCUMENT_CANCELLED");
          const text = sections.map((s) => s.text).join("\n\n");
          sql
            .prepare(
              "UPDATE ai_documents SET status='indexing',text=?,sections=?,page_count=?,updated_at=? WHERE id=? AND version=?",
            )
            .run(
              text,
              JSON.stringify(sections),
              Math.max(0, ...sections.map((s) => s.page ?? 0)),
              timestamp(),
              row.id,
              row.version,
            );
        },
      );
      if (stopped) return;
      transaction(sql, () => {
        const live = getDocument(sql, row.id);
        if (!live || live.version !== row.version || live.status !== "indexing")
          return;
        const count = (
          sql
            .prepare(
              "SELECT count(*) n FROM ai_knowledge_chunks WHERE NOT(document_id=? AND version=?)",
            )
            .get(row.id, row.version) as { n: number }
        ).n;
        if (count + result.chunks.length > 6000)
          throw new Error("DOCUMENT_CHUNK_LIMIT");
        sql
          .prepare(
            "DELETE FROM ai_knowledge_chunks WHERE document_id=? AND version=?",
          )
          .run(row.id, row.version);
        const insert = sql.prepare(
            "INSERT INTO ai_knowledge_chunks VALUES(?,?,?,?,?,?,?,?,?)",
          ),
          fts = sql.prepare(
            "INSERT INTO ai_knowledge_fts(chunk_id,tokens) VALUES(?,?)",
          );
        for (const [i, chunk] of result.chunks.entries()) {
          const id = `${row.id}:v${row.version}:${i}`,
            vector = Buffer.from(chunk.vector);
          insert.run(
            id,
            row.id,
            row.version,
            chunk.text,
            chunk.page ?? null,
            chunk.paragraph ?? null,
            vector,
            aiConfig().embeddingModel,
            vector.byteLength / 4,
          );
          fts.run(id, chunk.tokens);
        }
        sql
          .prepare(
            "UPDATE ai_documents SET status='draft',error=NULL,updated_at=? WHERE id=? AND version=?",
          )
          .run(timestamp(), row.id, row.version);
      });
    } catch (error) {
      if (!stopped) {
        const code =
          error instanceof Error && /^[A-Z_0-9]+$/.test(error.message)
            ? error.message
            : "DOCUMENT_PROCESSING_FAILED";
        sql
          .prepare(
            "UPDATE ai_documents SET status='failed',error=?,updated_at=? WHERE id=? AND version=? AND status IN ('extracting','indexing')",
          )
          .run(code, timestamp(), row.id, row.version);
      }
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => {
    void poll();
  }, 500);
  timer.unref();
  void poll();
  return () => {
    stopped = true;
    clearInterval(timer);
    abort.abort();
  };
}

export async function retrieveKnowledge(
  sql: DatabaseSync,
  query: string,
  signal?: AbortSignal,
): Promise<{ sources: KnowledgeSource[]; degraded: string[] }> {
  syncFaqIndex(sql);
  const activeFaqs = faqs(sql),
    sourceMap = new Map<string, KnowledgeSource>();
  for (const faq of activeFaqs)
    sourceMap.set(faqSourceId(faq), {
      id: faqSourceId(faq),
      title: faq.question,
      text: faq.answer,
      paragraph: 1,
    });
  const chunks = sql
    .prepare(
      `SELECT c.id,c.text,c.page,c.paragraph,c.document_id,c.version,c.model,c.dimensions,c.vector,d.name
    FROM ai_knowledge_chunks c JOIN ai_documents d ON d.id=c.document_id AND d.published_version=c.version`,
    )
    .all() as unknown as {
    id: string;
    text: string;
    page: number | null;
    paragraph: number | null;
    document_id: string;
    version: number;
    model: string;
    dimensions: number;
    vector: Uint8Array;
    name: string;
  }[];
  for (const c of chunks)
    sourceMap.set(c.id, {
      id: c.id,
      title: c.name,
      text: c.text,
      ...(c.page ? { page: c.page } : {}),
      ...(c.paragraph ? { paragraph: c.paragraph } : {}),
      documentId: c.document_id,
      version: c.version,
    });
  // Collapse content copies before either ranking branch takes its top 20.
  // Repeated uploads in different formats must not consume the context budget.
  const canonicalByText = new Map<string, string>(),
    canonicalIds = new Map<string, string>();
  for (const [id, source] of sourceMap) {
    const content = source.text.replace(/\s+/gu, " ").trim();
    const canonical = canonicalByText.get(content) ?? id;
    canonicalByText.set(content, canonical);
    canonicalIds.set(id, canonical);
  }
  const tokens = tokenize(query.slice(0, 1000))
      .split(" ")
      .filter(Boolean)
      .slice(0, 32),
    degraded: string[] = [];
  if (!tokens.length) return { sources: [], degraded };
  const match = tokens.map((t) => `"${t}"`).join(" OR ");
  // Filter to active sources before ranking, so retired chunks cannot crowd out live results.
  const lexical = (
    sql
      .prepare(
        `SELECT f.chunk_id,bm25(ai_knowledge_fts) rank FROM ai_knowledge_fts f
    WHERE ai_knowledge_fts MATCH ? AND (EXISTS(SELECT 1 FROM ai_knowledge_chunks c JOIN ai_documents d ON d.id=c.document_id
      WHERE c.id=f.chunk_id AND c.version=d.published_version) OR EXISTS(SELECT 1 FROM ai_knowledge_faqs q WHERE q.fingerprint=f.chunk_id))
    ORDER BY rank LIMIT ?`,
      )
      .all(match, sourceMap.size) as { chunk_id: string }[]
  )
    .map((r) => canonicalIds.get(r.chunk_id))
    .filter((id): id is string => !!id);
  const uniqueLexical = [...new Set(lexical)].slice(0, 20);
  let semantic: string[] = [];
  if (chunks.length) {
    try {
      const [queryVector] = await embed([query.slice(0, 1000)], signal);
      const config = aiConfig(),
        seen = new Set<string>(),
        vectors = chunks.flatMap((c) => {
          const canonical = canonicalIds.get(c.id)!;
          if (
            seen.has(canonical) ||
            c.model !== config.embeddingModel ||
            c.dimensions !== queryVector!.length
          )
            return [];
          seen.add(canonical);
          return [{ id: canonical, vector: c.vector }];
        });
      if (!vectors.length) degraded.push("embedding_model_changed");
      else
        semantic = (
          await runWorker<{ id: string; score: number }[]>(
            { type: "rank", query: queryVector, rows: vectors },
            signal,
            undefined,
            15000,
          )
        ).map((r) => r.id);
    } catch {
      if (signal?.aborted) throw new Error("KNOWLEDGE_CANCELLED");
      degraded.push("embedding_unavailable_keyword_only");
    }
  }
  const scores = new Map<string, number>();
  for (const list of [uniqueLexical, semantic])
    list.forEach((id, i) =>
      scores.set(id, (scores.get(id) ?? 0) + 1 / (60 + i + 1)),
    );
  const fused = [...scores.keys()]
    .sort((a, b) => scores.get(b)! - scores.get(a)!)
    .slice(0, 30);
  let selected = fused.slice(0, 6);
  if (fused.length) {
    try {
      selected = (
        await rerank(
          query.slice(0, 1000),
          fused.map((id) => sourceMap.get(id)!.text),
          signal,
        )
      )
        .map((i) => fused[i]!)
        .slice(0, 6);
    } catch {
      if (signal?.aborted) throw new Error("KNOWLEDGE_CANCELLED");
      degraded.push("reranker_unavailable_fusion_order");
    }
  }
  // A document can be disabled while embedding/reranking is running.
  return {
    sources: selected
      .map((id) => sourceMap.get(id)!)
      .filter((source) => sourcesStillValid(sql, [source])),
    degraded,
  };
}

export function sourcesStillValid(
  sql: DatabaseSync,
  sources: KnowledgeSource[],
): boolean {
  const faqIds = new Set(faqs(sql).map(faqSourceId));
  return sources.every((source) =>
    source.documentId
      ? !!sql
          .prepare(
            `SELECT 1 FROM ai_knowledge_chunks c JOIN ai_documents d
    ON d.id=c.document_id AND d.published_version=c.version WHERE c.id=? AND c.document_id=? AND c.version=?`,
          )
          .get(source.id, source.documentId, source.version ?? null)
      : faqIds.has(source.id),
  );
}
