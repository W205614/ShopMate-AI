import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase, readDatabase, writeDatabase } from "../src/database";
import { createSeed } from "../../shared/domain/seed";
import { context } from "../src/repository";
import { supportApi } from "../src/support";
import { commerceApi } from "../src/commerce";
import {
  createSupportProposal,
  executeSupportTool,
  processSupportRun,
  supportCommands,
} from "../src/ai-support";
import { ensureSupportSchema } from "../src/ai-schema";
import { ensureKnowledgeSchema } from "../src/ai-knowledge";

let sql: DatabaseSync;
const user = { id: "u1", name: "测试用户", role: "user" as const };
const asUser = <T>(work: () => T, uid = "u1") =>
  context.run({ sql, user: { ...user, id: uid }, admin: null }, work);
async function queued(text = "推荐一个商品") {
  const chatId = await asUser(() => supportApi.createConversation());
  await asUser(() => supportApi.sendMessage(chatId, text));
  return sql
    .prepare("SELECT * FROM support_runs WHERE conversation_id=?")
    .get(chatId) as never;
}
beforeEach(() => {
  vi.stubEnv("AI_ENABLED", "true");
  vi.stubEnv("LLM_API_KEY", "test-no-network");
  sql = openDatabase(":memory:");
  writeDatabase(sql, createSeed());
  ensureSupportSchema(sql);
  ensureKnowledgeSchema(sql);
});
afterEach(() => {
  sql.close();
  vi.unstubAllEnvs();
});

describe("AI support task and confirmation invariants", () => {
  it("corrects an invalid final shape within the existing provider-call budget", async () => {
    const run: any = await queued("帮我申请退款");
    const caller = vi
      .fn()
      .mockResolvedValueOnce({
        role: "assistant",
        content: JSON.stringify({ answer: "请提供订单", orderId: null }),
      })
      .mockResolvedValueOnce({
        role: "assistant",
        content: JSON.stringify({
          answer: "请提供订单号、退款原因和商品数量。",
          citations: [],
          productIds: [],
        }),
      });
    await processSupportRun(sql, run.id, caller);
    expect(caller).toHaveBeenCalledTimes(2);
    expect(
      sql
        .prepare("SELECT status,calls FROM support_runs WHERE id=?")
        .get(run.id),
    ).toEqual({ status: "completed", calls: 2 });
    expect(
      sql
        .prepare("SELECT count(*) AS n FROM support_proposals WHERE run_id=?")
        .get(run.id)?.n,
    ).toBe(0);
  });

  it("rejects repeated invalid output without exceeding four calls or saving it", async () => {
    const run: any = await queued();
    const caller = vi.fn(async () => ({
      role: "assistant" as const,
      content: '{"answer":"unchecked","orderId":null}',
    }));
    await processSupportRun(sql, run.id, caller);
    expect(caller).toHaveBeenCalledTimes(4);
    expect(
      sql
        .prepare("SELECT status,error,calls FROM support_runs WHERE id=?")
        .get(run.id),
    ).toEqual({ status: "failed", error: "AI_INVALID_RESPONSE", calls: 4 });
    expect(
      readDatabase(sql)
        .conversations.find((c) => c.id === run.conversation_id)!
        .messages.some((m) => m.text === "unchecked"),
    ).toBe(false);
  });

  it("grounds context cards in a fresh server lookup even when the final answer needs no tool call", async () => {
    const chatId = await asUser(() =>
      supportApi.createConversation({ productId: "p01" }),
    );
    await asUser(() =>
      supportApi.sendMessage(chatId, "这个商品的价格是多少？"),
    );
    const run = sql
      .prepare("SELECT id FROM support_runs WHERE conversation_id=?")
      .get(chatId)!;
    const product = readDatabase(sql).products.find((p) => p.id === "p01")!;
    const caller = vi.fn(async (messages: unknown[]) => {
      const source = messages.find(
        (m) => (m as { name?: string }).name === "server_context",
      ) as { role: string; content: string };
      expect(source.role).toBe("user");
      expect(source.content).toContain(product.name);
      expect(source.content).toContain(String(product.skus[0]!.price));
      expect(source.content).not.toMatch(/phone|password|address/);
      return {
        role: "assistant" as const,
        content: JSON.stringify({
          answer: "请核对下方实时商品卡片。",
          productIds: ["p01"],
          citations: [],
        }),
      };
    });
    await processSupportRun(sql, String(run.id), caller);
    expect(
      sql.prepare("SELECT status FROM support_runs WHERE id=?").get(run.id)
        ?.status,
    ).toBe("completed");
    expect(
      readDatabase(sql)
        .conversations.find((c) => c.id === chatId)!
        .messages.at(-1)?.productIds,
    ).toEqual(["p01"]);
  });
  it("allows ordinary cart writes while a model request is awaiting its provider", async () => {
    const run: any = await queued();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const processing = processSupportRun(sql, run.id, async () => {
      await gate;
      return {
        role: "assistant",
        content: JSON.stringify({
          answer: "请查看已更新的购物车。",
          citations: [],
        }),
      };
    });
    expect(sql.isTransaction).toBe(false);
    const before = readDatabase(sql)
      .carts.filter((c) => c.userId === "u1" && c.skuId === "p01-s1")
      .reduce((n, c) => n + c.quantity, 0);
    await asUser(() => commerceApi.addCart("p01", "p01-s1", 1));
    expect(
      readDatabase(sql)
        .carts.filter((c) => c.userId === "u1" && c.skuId === "p01-s1")
        .reduce((n, c) => n + c.quantity, 0),
    ).toBe(before + 1);
    release();
    await processing;
    expect(
      sql.prepare("SELECT status FROM support_runs WHERE id=?").get(run.id)
        ?.status,
    ).toBe("completed");
  });
  it("queues durably without calling the provider or keeping the transaction open", async () => {
    const run: any = await queued();
    expect(run.status).toBe("queued");
    expect(sql.isTransaction).toBe(false);
    expect(
      readDatabase(sql)
        .conversations.find((c) => c.id === run.conversation_id)!
        .messages.at(-1)?.role,
    ).toBe("user");
    await expect(
      asUser(() => supportApi.sendMessage(run.conversation_id, "重复发送")),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      readDatabase(sql)
        .conversations.find((c) => c.id === run.conversation_id)!
        .messages.filter((m) => m.text === "重复发送"),
    ).toHaveLength(0);
  });
  it("finishes a bounded model round and restores its answer without duplication", async () => {
    const run: any = await queued();
    const caller = vi.fn(async () => ({
      role: "assistant" as const,
      content: JSON.stringify({
        answer: "请补充你想找的商品类别。",
        citations: [],
        productIds: [],
      }),
    }));
    await processSupportRun(sql, run.id, caller);
    await processSupportRun(sql, run.id, caller);
    expect(caller).toHaveBeenCalledTimes(1);
    expect(
      readDatabase(sql)
        .conversations.find((c) => c.id === run.conversation_id)!
        .messages.filter((m) => m.id === `ai-${run.id}`),
    ).toHaveLength(1);
    expect(
      sql.prepare("SELECT status FROM support_runs WHERE id=?").get(run.id)
        ?.status,
    ).toBe("completed");
  });
  it("rejects invented source and order IDs and exposes a rule fallback", async () => {
    const run: any = await queued();
    await processSupportRun(sql, run.id, async () => ({
      role: "assistant",
      content: JSON.stringify({
        answer: "已退款",
        citations: ["invented"],
        orderId: "other-user",
      }),
    }));
    expect(
      sql.prepare("SELECT status FROM support_runs WHERE id=?").get(run.id)
        ?.status,
    ).toBe("failed");
    const c = readDatabase(sql).conversations.find(
      (c) => c.id === run.conversation_id,
    )!;
    expect(c.messages.at(-1)?.source).toBe("rule");
    expect(c.messages.some((m) => m.text === "已退款")).toBe(false);
  });
  it("does not append a late model reply after transfer to human", async () => {
    const run: any = await queued();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const processing = processSupportRun(sql, run.id, async () => {
      await gate;
      return {
        role: "assistant",
        content: JSON.stringify({ answer: "迟到回复", citations: [] }),
      };
    });
    await asUser(() => supportApi.transferConversation(run.conversation_id));
    release();
    await processing;
    const c = readDatabase(sql).conversations.find(
      (c) => c.id === run.conversation_id,
    )!;
    expect(c.status).toBe("waiting");
    expect(c.messages.some((m) => m.text === "迟到回复")).toBe(false);
    expect(
      sql.prepare("SELECT status FROM support_runs WHERE id=?").get(run.id)
        ?.status,
    ).toBe("cancelled");
  });
  it("makes a real tool round, filters private order fields, and enforces ownership", async () => {
    const run: any = await queued();
    sql
      .prepare("UPDATE support_runs SET status='running' WHERE id=?")
      .run(run.id);
    const evidence = {
      sources: [],
      products: new Set<string>(),
      productCaps: new Map<string, number | undefined>(),
      orders: new Set<string>(),
      degraded: [],
    };
    const mine: any = await asUser(() =>
      executeSupportTool(
        sql,
        run,
        "my_orders",
        {},
        new AbortController().signal,
        evidence,
      ),
    );
    expect(JSON.stringify(mine)).not.toMatch(/138|phone|address|password/);
    const other = readDatabase(sql).orders.find((o) => o.userId !== "u1");
    if (other)
      await expect(
        asUser(() =>
          executeSupportTool(
            sql,
            run,
            "order_details",
            { orderId: other.id },
            new AbortController().signal,
            evidence,
          ),
        ),
      ).rejects.toMatchObject({ status: 404 });
    await expect(
      asUser(() =>
        executeSupportTool(
          sql,
          run,
          "my_orders",
          { userId: "u2" },
          new AbortController().signal,
          evidence,
        ),
      ),
    ).rejects.toThrow();
    await expect(
      asUser(() =>
        executeSupportTool(
          sql,
          run,
          "arbitrary_sql",
          {},
          new AbortController().signal,
          evidence,
        ),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
  it("confirms addCart and proposal consumption atomically; repeats do not add twice", async () => {
    const run: any = await queued();
    sql
      .prepare("UPDATE support_runs SET status='running' WHERE id=?")
      .run(run.id);
    const before = readDatabase(sql)
      .carts.filter((c) => c.userId === "u1" && c.skuId === "p01-s1")
      .reduce((n, c) => n + c.quantity, 0);
    const p = asUser(() =>
      createSupportProposal(sql, run, {
        kind: "addCart",
        productId: "p01",
        skuId: "p01-s1",
        quantity: 1,
      }),
    );
    expect(
      readDatabase(sql)
        .carts.filter((c) => c.userId === "u1" && c.skuId === "p01-s1")
        .reduce((n, c) => n + c.quantity, 0),
    ).toBe(before);
    await expect(
      asUser(() => supportCommands.confirmSupportProposal(p.id), "u2"),
    ).rejects.toMatchObject({ status: 404 });
    sql
      .prepare("UPDATE support_runs SET status='completed' WHERE id=?")
      .run(run.id);
    await asUser(() => supportCommands.confirmSupportProposal(p.id));
    await asUser(() => supportCommands.confirmSupportProposal(p.id));
    expect(
      readDatabase(sql)
        .carts.filter((c) => c.userId === "u1" && c.skuId === "p01-s1")
        .reduce((n, c) => n + c.quantity, 0),
    ).toBe(before + 1);
    expect(
      sql.prepare("SELECT status FROM support_proposals WHERE id=?").get(p.id)
        ?.status,
    ).toBe("confirmed");
  });
  it("rejects a proposal if price, expiry or conversation state changed", async () => {
    const run: any = await queued();
    sql
      .prepare("UPDATE support_runs SET status='running' WHERE id=?")
      .run(run.id);
    const p = asUser(() =>
      createSupportProposal(sql, run, {
        kind: "addCart",
        productId: "p01",
        skuId: "p01-s1",
        quantity: 1,
      }),
    );
    const db = readDatabase(sql);
    db.products.find((p) => p.id === "p01")!.skus[0]!.price++;
    writeDatabase(sql, db);
    sql
      .prepare("UPDATE support_runs SET status='completed' WHERE id=?")
      .run(run.id);
    await expect(
      asUser(() => supportCommands.confirmSupportProposal(p.id)),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      sql.prepare("SELECT status FROM support_proposals WHERE id=?").get(p.id)
        ?.status,
    ).toBe("pending");
    sql
      .prepare("UPDATE support_proposals SET expires_at=0 WHERE id=?")
      .run(p.id);
    await expect(
      asUser(() => supportCommands.confirmSupportProposal(p.id)),
    ).rejects.toThrow("失效");
    await asUser(() => supportApi.transferConversation(run.conversation_id));
    expect(
      sql.prepare("SELECT status FROM support_proposals WHERE id=?").get(p.id)
        ?.status,
    ).toBe("cancelled");
  });
  it("uses the same cancellation and aftersale rules as ordinary business actions", async () => {
    const run: any = await queued();
    sql
      .prepare("UPDATE support_runs SET status='running' WHERE id=?")
      .run(run.id);
    const order = readDatabase(sql).orders.find(
      (o) => o.userId === "u1" && o.status === "pending",
    );
    if (order) {
      const p = asUser(() =>
        createSupportProposal(sql, run, {
          kind: "cancelOrder",
          orderId: order.id,
        }),
      );
      sql
        .prepare("UPDATE support_runs SET status='completed' WHERE id=?")
        .run(run.id);
      await asUser(() => supportCommands.confirmSupportProposal(p.id));
      expect(
        readDatabase(sql).orders.find((o) => o.id === order.id)?.status,
      ).toBe("cancelled");
    }
    const paid = readDatabase(sql).orders.find(
      (o) =>
        o.userId === "u1" &&
        ["paid", "shipped", "completed"].includes(o.status) &&
        !readDatabase(sql).afterSales.some((a) => a.orderId === o.id),
    );
    if (paid) {
      sql
        .prepare("UPDATE support_runs SET status='running' WHERE id=?")
        .run(run.id);
      const args = {
        kind: "requestAfterSale" as const,
        orderId: paid.id,
        reason: "测试原因",
        description: "申请合成资料验收售后",
        lines: [{ orderItemId: paid.items[0]!.id, quantity: 1 }],
      };
      const p = asUser(() => createSupportProposal(sql, run, args));
      sql
        .prepare("UPDATE support_runs SET status='completed' WHERE id=?")
        .run(run.id);
      await asUser(() => supportCommands.confirmSupportProposal(p.id));
      expect(
        readDatabase(sql).afterSales.some(
          (a) => a.orderId === paid.id && a.reason === "测试原因",
        ),
      ).toBe(true);
    }
    await expect(
      asUser(() => commerceApi.cancelOrder("missing")),
    ).rejects.toThrow();
  });
});
