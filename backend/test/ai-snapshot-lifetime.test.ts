import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase, writeDatabase, transaction } from "../src/database";
import { createSeed } from "../../shared/domain/seed";
import { context } from "../src/repository";
import { supportApi } from "../src/support";
import { createSupportProposal, processSupportRun } from "../src/ai-support";
import { insertStoredRecord } from "../src/storage";
import { ensureSupportSchema } from "../src/ai-schema";

let sql: DatabaseSync;
const asUser = <T>(work: () => T, id = "u1") =>
  context.run({ sql, user: { id, role: "user", name: id }, admin: null }, work);
beforeEach(() => {
  vi.stubEnv("AI_ENABLED", "true");
  sql = openDatabase(":memory:");
  writeDatabase(sql, createSeed());
  ensureSupportSchema(sql);
});
afterEach(() => {
  vi.restoreAllMocks();
  sql.close();
  vi.unstubAllEnvs();
});
async function queued() {
  const conversation = await asUser(() =>
    supportApi.createConversation({ productId: "p01" }),
  );
  await asUser(() => supportApi.sendMessage(conversation, "你好"));
  return sql
    .prepare("SELECT * FROM support_runs WHERE conversation_id=?")
    .get(conversation)!;
}
function captureReads() {
  const statements: string[] = [];
  const prepare = sql.prepare.bind(sql);
  vi.spyOn(sql, "prepare").mockImplementation((query) => {
    statements.push(query);
    return prepare(query);
  });
  return statements;
}
function deliver(id: string) {
  transaction(sql, () =>
    insertStoredRecord(sql, "notifications", {
      id,
      userId: "u2",
      text: "independent notification",
      read: false,
      createdAt: new Date().toISOString(),
    }),
  );
}

it("proposal dry-run reads only its explicit business projection and releases successful, replayed and rejected snapshots", async () => {
  const run = await queued();
  sql
    .prepare("UPDATE support_runs SET status='running' WHERE id=?")
    .run(run.id);
  const statements = captureReads();
  const input = {
    kind: "addCart",
    productId: "p01",
    skuId: "p01-s1",
    quantity: 1,
  };
  const proposal = asUser(() =>
    createSupportProposal(sql, run as never, input),
  );
  expect(asUser(() => createSupportProposal(sql, run as never, input)).id).toBe(
    proposal.id,
  );
  expect(() =>
    asUser(() =>
      createSupportProposal(sql, run as never, {
        ...input,
        productId: "missing",
      }),
    ),
  ).toThrow();
  deliver("after-proposals");
  expect(
    statements.filter((query) =>
      /SELECT key,position,data FROM biz_(notifications|checkout_quotes|addresses|users|ledger|inventory|conversations)/.test(
        query,
      ),
    ),
  ).toEqual([]);
});

it.each([false, true])(
  "releases product context before await and limits completed/failed conversation writes (failure=%s)",
  async (failure) => {
    const unrelated = await asUser(() => supportApi.createConversation(), "u2");
    const before = sql
      .prepare("SELECT data FROM biz_conversations WHERE key=?")
      .get(unrelated)!.data;
    const run = await queued();
    const statements = captureReads();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const processing = processSupportRun(sql, String(run.id), async () => {
      await gate;
      if (failure) throw new Error("synthetic failure");
      return {
        role: "assistant",
        content: JSON.stringify({
          answer: "请查看实时商品卡片。",
          productIds: ["p01"],
          citations: [],
        }),
      };
    });
    try {
      deliver("while-model-awaits");
    } finally {
      release();
    }
    await processing;
    deliver("after-model-finishes");
    expect(
      sql.prepare("SELECT status FROM support_runs WHERE id=?").get(run.id)
        ?.status,
    ).toBe(failure ? "failed" : "completed");
    expect(
      sql
        .prepare("SELECT data FROM biz_conversations WHERE key=?")
        .get(unrelated)!.data,
    ).toBe(before);
    expect(
      statements.filter((query) =>
        /SELECT key,position,data FROM biz_notifications/.test(query),
      ),
    ).toEqual([]);
    const conversationReads = statements.filter((query) =>
      query.startsWith("SELECT key,position,data FROM biz_conversations"),
    );
    expect(conversationReads).toHaveLength(1);
    expect(conversationReads[0]).toContain("WHERE user_id=? AND key IN (?)");
  },
);
