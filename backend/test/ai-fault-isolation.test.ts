import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { createApp } from "../src/app";
import { openDatabase, readDatabase, writeDatabase } from "../src/database";
import { createSeed } from "../../shared/domain/seed";
import { tokenHash } from "../src/auth";
import { context } from "../src/repository";
import { supportApi } from "../src/support";
import { processSupportRun } from "../src/ai-support";
import { startKnowledgeWorker } from "../src/ai-knowledge";

let sql: DatabaseSync, server: Server, provider: Server, base: string;
let stopKnowledge: (() => void) | undefined;
let fault: "timeout" | "429" | "json" | "embedding" | "healthy";
let release: () => void, reached: Promise<void>;
const user = { id: "u1", name: "Buyer", role: "user" as const };
const asUser = <T>(work: () => T) =>
  context.run({ sql, user, admin: null }, work);
const listen = async (server: Server) => {
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
};

beforeEach(async () => {
  sql = openDatabase(":memory:");
  writeDatabase(sql, createSeed());
  for (const [id, role] of [
    ["u1", "user"],
    ["admin", "admin"],
  ]) {
    sql
      .prepare("INSERT INTO accounts VALUES(?,?,?,?,?,?)")
      .run(id, id, id, role, "synthetic", 1);
    sql
      .prepare("INSERT INTO sessions VALUES(?,?,?)")
      .run(tokenHash(`${id}-token`), id, Date.now() + 60000);
  }
  let arrive!: () => void;
  reached = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  provider = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    expect(sql.isTransaction).toBe(false);
    arrive();
    await gate;
    if (fault === "timeout") return; // The real provider client must abort this HTTP request.
    if (fault === "429" || fault === "embedding") {
      res.statusCode = 429;
      return void res.end("synthetic sensitive provider response");
    }
    if (fault === "json") return void res.end("not-json");
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
    else
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: JSON.stringify({
                  answer: "你好，请查看商城页面的实时信息。",
                  citations: [],
                  productIds: [],
                }),
              },
              finish_reason: "stop",
            },
          ],
        }),
      );
  });
  const providerBase = await listen(provider);
  vi.stubEnv("AI_ENABLED", "true");
  vi.stubEnv("AI_PROVIDER_TIMEOUT_MS", "2000");
  vi.stubEnv("LLM_API_KEY", "synthetic-no-external-network");
  vi.stubEnv("LLM_BASE_URL", providerBase);
  vi.stubEnv("EMBEDDING_API_KEY", "synthetic-no-external-network");
  vi.stubEnv("EMBEDDING_BASE_URL", providerBase);
  vi.stubEnv("EMBEDDING_DIMENSIONS", "3");
  server = createServer(
    await createApp(sql, { origins: ["http://localhost"] }),
  );
  base = await listen(server);
  sql.prepare("INSERT INTO staff_access VALUES('admin','owner',1)").run();
});

afterEach(async () => {
  release();
  stopKnowledge?.();
  stopKnowledge = undefined;
  for (const s of [server, provider]) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  sql.close();
  vi.unstubAllEnvs();
});

async function post(path: string, body: unknown, role = "user") {
  const response = await fetch(base + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-ShopMate-Request": "1",
      Cookie: `shopmate_${role}=${role === "user" ? "u1" : "admin"}-token`,
    },
    body: JSON.stringify(body),
  });
  expect(response.status, await response.clone().text()).toBeLessThan(300);
  return response.json();
}
async function action(
  method: string,
  args: unknown[],
  requestId: string = crypto.randomUUID(),
) {
  return (await post(`/api/actions/${method}`, { args, requestId })).result;
}
async function ordinaryOrder() {
  expect(sql.isTransaction).toBe(false);
  const before = readDatabase(sql);
  const quantity = before.carts
    .filter((c) => c.userId === "u1" && c.skuId === "p01-s1")
    .reduce((n, c) => n + c.quantity, 0);
  await action("addCart", ["p01", "p01-s1", 1]);
  const quote = await action("quoteCheckout", [
    {
      source: {
        type: "buyNow",
        productId: "p01",
        skuId: "p01-s1",
        quantity: 1,
      },
      addressId: "a1",
    },
  ]);
  const requestId = crypto.randomUUID();
  const orderId = await action("createOrder", [
    { quoteId: quote.id, requestId },
  ]);
  expect(await action("createOrder", [{ quoteId: quote.id, requestId }])).toBe(
    orderId,
  );
  const after = readDatabase(sql);
  expect(after.orders.filter((order) => order.id === orderId)).toHaveLength(1);
  expect(
    after.carts
      .filter((c) => c.userId === "u1" && c.skuId === "p01-s1")
      .reduce((n, c) => n + c.quantity, 0),
  ).toBe(quantity + 1);
  expect(after.products).toEqual(before.products); // Unpaid orders reserve stock; they do not deduct it.
  return orderId;
}

it.each(["timeout", "429", "json"] as const)(
  "isolates provider %s from HTTP cart/checkout and recovers the persisted consultation",
  async (mode) => {
    fault = mode;
    const chatId = await asUser(() => supportApi.createConversation());
    await asUser(() => supportApi.sendMessage(chatId, "你好"));
    const runId = String(
      sql
        .prepare("SELECT id FROM support_runs WHERE conversation_id=?")
        .get(chatId)!.id,
    );
    const processing = processSupportRun(sql, runId);
    await reached;
    expect(
      sql.prepare("SELECT status FROM support_runs WHERE id=?").get(runId)
        ?.status,
    ).toBe("running");
    await ordinaryOrder();
    release();
    await processing;
    expect(
      sql
        .prepare("SELECT status,error FROM support_runs WHERE id=?")
        .get(runId),
    ).toEqual({ status: "failed", error: "AI_PROVIDER_FAILED" });
    expect(JSON.stringify(readDatabase(sql).conversations)).not.toContain(
      "synthetic sensitive provider response",
    );
    fault = "healthy";
    await action("retrySupportRun", [runId]);
    await processSupportRun(sql, runId);
    expect(
      sql.prepare("SELECT status FROM support_runs WHERE id=?").get(runId)
        ?.status,
    ).toBe("completed");
    expect(
      readDatabase(sql)
        .conversations.find((c) => c.id === chatId)!
        .messages.filter((m) => m.source === "ai"),
    ).toHaveLength(1);
    expect(sql.isTransaction).toBe(false);
  },
  15000,
);

it("isolates document embedding failure from HTTP checkout and retries without publishing failed knowledge", async () => {
  fault = "embedding";
  const { document } = await post(
    "/api/support/documents",
    {
      name: "policy.md",
      contentBase64: Buffer.from(
        "售后政策：七天内可以申请售后，具体条件请咨询人工客服。",
      ).toString("base64"),
      requestId: crypto.randomUUID(),
    },
    "admin",
  );
  stopKnowledge = startKnowledgeWorker(sql);
  await reached;
  expect(
    sql.prepare("SELECT status FROM ai_documents WHERE id=?").get(document.id)
      ?.status,
  ).toBe("indexing");
  await ordinaryOrder();
  release();
  await vi.waitFor(
    () =>
      expect(
        sql
          .prepare("SELECT status FROM ai_documents WHERE id=?")
          .get(document.id)?.status,
      ).toBe("failed"),
    { timeout: 10000 },
  );
  expect(
    sql
      .prepare("SELECT published_version FROM ai_documents WHERE id=?")
      .get(document.id)?.published_version,
  ).toBeNull();
  expect(
    sql
      .prepare(
        "SELECT count(*) AS n FROM ai_knowledge_chunks WHERE document_id=?",
      )
      .get(document.id)?.n,
  ).toBe(0);
  fault = "healthy";
  await post(
    `/api/support/documents/${document.id}/actions`,
    {
      action: "retry",
      version: document.version,
      requestId: crypto.randomUUID(),
    },
    "admin",
  );
  await vi.waitFor(
    () =>
      expect(
        sql
          .prepare("SELECT status FROM ai_documents WHERE id=?")
          .get(document.id)?.status,
      ).toBe("draft"),
    { timeout: 10000 },
  );
  expect(
    sql
      .prepare("SELECT published_version FROM ai_documents WHERE id=?")
      .get(document.id)?.published_version,
  ).toBeNull();
  await ordinaryOrder();
}, 20000);
