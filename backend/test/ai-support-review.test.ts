import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import type { CheckoutInput } from "../../shared/domain/types";
import { createSeed } from "../../shared/domain/seed";
import { openDatabase, readDatabase, writeDatabase } from "../src/database";
import { commandReadScope, context } from "../src/repository";
import { commerceApi } from "../src/commerce";
import { availableStock } from "../src/commerce-rules";
import { supportApi } from "../src/support";
import {
  createSupportProposal,
  executeSupportTool,
  processSupportRun,
  supportCommands,
} from "../src/ai-support";
import { ensureSupportSchema } from "../src/ai-schema";
import { ensureRuntimeSchema } from "../src/runtime";
import { createApp } from "../src/app";
import { createAccount } from "../src/auth";

type Run = Parameters<typeof createSupportProposal>[1];
let sql: DatabaseSync;
const user = (uid = "u1") => ({
  id: uid,
  name: "测试会员",
  role: "user" as const,
});
function asUser<T>(work: () => T, uid = "u1") {
  return context.run({ sql, user: user(uid), admin: null }, work);
}
function command<T>(
  method: string,
  args: unknown[],
  work: () => T,
  requestId = crypto.randomUUID(),
  uid = "u1",
) {
  return context.run(
    {
      sql,
      user: user(uid),
      admin: null,
      command: { method, args, requestId, fingerprint: JSON.stringify(args) },
    },
    work,
  );
}
async function order(quantity = 1, uid = "u1") {
  const input: CheckoutInput = {
    addressId: uid === "u1" ? "a1" : "a2",
    source: { type: "buyNow", productId: "p01", skuId: "p01-s1", quantity },
  };
  const quote = await command(
    "quoteCheckout",
    [input],
    () => commerceApi.quoteCheckout(input),
    undefined,
    uid,
  );
  const create = { quoteId: quote.id, requestId: crypto.randomUUID() };
  return command(
    "createOrder",
    [create],
    () => commerceApi.createOrder(create),
    undefined,
    uid,
  );
}
async function running(uid = "u1") {
  const conversation = await command(
    "createConversation",
    [],
    () => supportApi.createConversation(),
    undefined,
    uid,
  );
  await command(
    "sendMessage",
    [conversation, "请帮我办理订单业务"],
    () => supportApi.sendMessage(conversation, "请帮我办理订单业务"),
    undefined,
    uid,
  );
  sql
    .prepare("UPDATE support_runs SET status='running' WHERE conversation_id=?")
    .run(conversation);
  return sql
    .prepare("SELECT * FROM support_runs WHERE conversation_id=?")
    .get(conversation) as Run;
}
function confirm(
  proposalId: string,
  requestId = crypto.randomUUID(),
  uid = "u1",
) {
  return command(
    "confirmSupportProposal",
    [proposalId],
    () => supportCommands.confirmSupportProposal(proposalId),
    requestId,
    uid,
  );
}

beforeEach(() => {
  vi.stubEnv("AI_ENABLED", "true");
  vi.stubEnv("LLM_API_KEY", "synthetic-no-network");
  sql = openDatabase(":memory:");
  writeDatabase(sql, createSeed());
  ensureSupportSchema(sql);
  ensureRuntimeSchema(sql);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  sql.close();
});

describe("independent AI support confirmation review", () => {
  it("rejects early confirmation without business writes and permits the same request after the answer completes", async () => {
    const target = await order(),
      run = await running();
    const proposal = asUser(() =>
      createSupportProposal(sql, run, { kind: "cancelOrder", orderId: target }),
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const processing = processSupportRun(sql, run.id, async () => {
      await gate;
      return {
        role: "assistant",
        content: JSON.stringify({
          answer: "请核对取消订单卡片，再点击确认。",
          citations: [],
        }),
      };
    });
    const before = readDatabase(sql),
      requestId = crypto.randomUUID();
    try {
      await expect(confirm(proposal.id, requestId)).rejects.toMatchObject({
        status: 409,
        code: "PROPOSAL_NOT_READY",
      });
      expect(readDatabase(sql)).toEqual(before);
      expect(
        sql
          .prepare("SELECT status,result FROM support_proposals WHERE id=?")
          .get(proposal.id),
      ).toEqual({ status: "pending", result: null });
      expect(
        sql
          .prepare(
            "SELECT count(*) AS n FROM command_results WHERE request_id=?",
          )
          .get(requestId)?.n,
      ).toBe(0);
    } finally {
      release();
      await processing;
    }
    expect(
      sql.prepare("SELECT status FROM support_runs WHERE id=?").get(run.id)
        ?.status,
    ).toBe("completed");
    await confirm(proposal.id, requestId);
    expect(readDatabase(sql).orders.find((o) => o.id === target)?.status).toBe(
      "cancelled",
    );
    expect(
      sql
        .prepare("SELECT status FROM support_proposals WHERE id=?")
        .get(proposal.id)?.status,
    ).toBe("confirmed");
  });

  it("hides pending cards in the authenticated detail endpoint until completion while retaining cancelled and confirmed history", async () => {
    const account = await createAccount(sql, {
      username: "proposal_visibility",
      name: "提案可见性",
      password: "VisibilityTest123!",
    });
    const app = await createApp(sql, { origins: ["http://localhost"] }),
      server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.on("listening", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const login = await fetch(base + "/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-ShopMate-Request": "1",
        },
        body: JSON.stringify({
          username: "proposal_visibility",
          password: "VisibilityTest123!",
          role: "user",
        }),
      });
      expect(login.status).toBe(200);
      const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
      const run = await running(account.id),
        input = {
          kind: "addCart" as const,
          productId: "p01",
          skuId: "p01-s1",
          quantity: 1,
        };
      const cancelled = asUser(
        () => createSupportProposal(sql, run, input),
        account.id,
      );
      await asUser(
        () => supportCommands.cancelSupportProposal(cancelled.id),
        account.id,
      );
      const pending = asUser(
        () => createSupportProposal(sql, run, input),
        account.id,
      );
      const detail = async () => {
        const response = await fetch(
          base + `/api/support/conversations/${run.conversation_id}`,
          { headers: { Cookie: cookie } },
        );
        expect(response.status).toBe(200);
        return (await response.json()) as {
          proposals: { id: string; status: string }[];
        };
      };
      expect((await detail()).proposals).toEqual([
        expect.objectContaining({ id: cancelled.id, status: "cancelled" }),
      ]);
      await processSupportRun(sql, run.id, async () => ({
        role: "assistant",
        content: JSON.stringify({
          answer: "请核对加购卡片后确认。",
          citations: [],
        }),
      }));
      expect((await detail()).proposals).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: pending.id, status: "pending" }),
          expect.objectContaining({ id: cancelled.id, status: "cancelled" }),
        ]),
      );
      await confirm(pending.id, undefined, account.id);
      await command(
        "sendMessage",
        [run.conversation_id, "继续咨询"],
        () => supportApi.sendMessage(run.conversation_id, "继续咨询"),
        undefined,
        account.id,
      );
      const nextRun = sql
        .prepare(
          "SELECT * FROM support_runs WHERE conversation_id=? AND status='queued'",
        )
        .get(run.conversation_id) as Run;
      sql
        .prepare("UPDATE support_runs SET status='running' WHERE id=?")
        .run(nextRun.id);
      const hidden = asUser(
        () => createSupportProposal(sql, nextRun, { ...input, quantity: 2 }),
        account.id,
      );
      const history = (await detail()).proposals;
      expect(history).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: pending.id, status: "confirmed" }),
          expect.objectContaining({ id: cancelled.id, status: "cancelled" }),
        ]),
      );
      expect(history.some((p) => p.id === hidden.id)).toBe(false);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("cancels a newly created reserved order exactly once through the command scope and preserves other orders", async () => {
    const target = await order(2),
      other = await order(1, "u2"),
      run = await running();
    const prior = readDatabase(sql),
      otherOrder = prior.orders.find((o) => o.id === other)!,
      stockBefore = availableStock(prior, "p01", "p01-s1");
    const proposal = asUser(() =>
      createSupportProposal(sql, run, { kind: "cancelOrder", orderId: target }),
    );
    expect(readDatabase(sql).orders.find((o) => o.id === target)?.status).toBe(
      "pending",
    );
    sql
      .prepare("UPDATE support_runs SET status='completed' WHERE id=?")
      .run(run.id);
    const requestId = crypto.randomUUID();
    const first = await confirm(proposal.id, requestId);
    expect(await confirm(proposal.id, requestId)).toEqual(first);
    expect(await confirm(proposal.id)).toEqual(first);
    const after = readDatabase(sql),
      cancelled = after.orders.find((o) => o.id === target)!;
    expect(cancelled.status).toBe("cancelled");
    expect(
      cancelled.events.filter((event) => event.action === "cancelled"),
    ).toHaveLength(1);
    expect(availableStock(after, "p01", "p01-s1")).toBe(stockBefore + 2);
    expect(after.orders.find((o) => o.id === other)).toEqual(otherOrder);
    expect(after.orders).toHaveLength(prior.orders.length);
    expect(
      after.conversations
        .find((c) => c.id === run.conversation_id)!
        .messages.filter((m) => m.text.startsWith("已根据你的确认完成")),
    ).toHaveLength(1);
  });

  it("loads a real paid order for aftersale confirmation and never rewrites or loses unrelated history", async () => {
    const target = await order(2);
    await command("payOrder", [target], () => commerceApi.payOrder(target));
    const run = await running(),
      before = readDatabase(sql),
      paid = before.orders.find((o) => o.id === target)!;
    expect(paid.status).toBe("paid");
    const proposal = asUser(() =>
      createSupportProposal(sql, run, {
        kind: "requestAfterSale",
        orderId: target,
        reason: "包装破损",
        description: "合成验收资料：申请一件商品售后",
        lines: [{ orderItemId: paid.items[0]!.id, quantity: 1 }],
      }),
    );
    const scope = commandReadScope(
      sql,
      {
        method: "confirmSupportProposal",
        args: [proposal.id],
        requestId: "scope",
        fingerprint: "scope",
      },
      user(),
    );
    expect(scope.orderIds).toContain(target);
    expect(readDatabase(sql, scope).orders.some((o) => o.id === target)).toBe(
      true,
    );
    expect(
      readDatabase(sql).afterSales.filter((sale) => sale.orderId === target),
    ).toHaveLength(0);
    await expect(confirm(proposal.id, undefined, "u2")).rejects.toMatchObject({
      status: 404,
    });
    sql
      .prepare("UPDATE support_runs SET status='completed' WHERE id=?")
      .run(run.id);
    await confirm(proposal.id);
    await confirm(proposal.id);
    const after = readDatabase(sql),
      sales = after.afterSales.filter((sale) => sale.orderId === target);
    expect(sales).toHaveLength(1);
    expect(sales[0]!.refundAmount).toBe(
      (proposal.details as { refundAmount: number }).refundAmount,
    );
    expect(sales[0]!.userId).toBe("u1");
    expect(sales[0]!.status).toBe("requested");
    expect(after.orders.filter((o) => o.id !== target)).toEqual(
      before.orders.filter((o) => o.id !== target),
    );
    expect(
      after.orders
        .find((o) => o.id === target)!
        .events.filter((event) => event.action === "afterSaleRequested"),
    ).toHaveLength(1);
  });

  it("rolls back proposal consumption, business writes, messages and idempotency on a late persistence failure", async () => {
    const target = await order();
    await command("payOrder", [target], () => commerceApi.payOrder(target));
    const run = await running(),
      paid = readDatabase(sql).orders.find((o) => o.id === target)!;
    const proposal = asUser(() =>
      createSupportProposal(sql, run, {
        kind: "requestAfterSale",
        orderId: target,
        reason: "质量问题",
        description: "合成资料用于事务回滚验收",
        lines: [{ orderItemId: paid.items[0]!.id, quantity: 1 }],
      }),
    );
    sql
      .prepare("UPDATE support_runs SET status='completed' WHERE id=?")
      .run(run.id);
    const before = readDatabase(sql),
      requestId = crypto.randomUUID();
    sql.exec(
      "CREATE TEMP TRIGGER fail_support_message BEFORE UPDATE ON biz_conversations BEGIN SELECT RAISE(ABORT, 'INJECTED_PERSIST_FAILURE'); END;",
    );
    await expect(confirm(proposal.id, requestId)).rejects.toThrow(
      "INJECTED_PERSIST_FAILURE",
    );
    expect(readDatabase(sql)).toEqual(before);
    expect(
      sql
        .prepare("SELECT status,result FROM support_proposals WHERE id=?")
        .get(proposal.id),
    ).toEqual({ status: "pending", result: null });
    expect(
      sql
        .prepare("SELECT count(*) AS n FROM command_results WHERE request_id=?")
        .get(requestId)?.n,
    ).toBe(0);
    sql.exec("DROP TRIGGER fail_support_message");
    await confirm(proposal.id, requestId);
    expect(
      readDatabase(sql).afterSales.filter((sale) => sale.orderId === target),
    ).toHaveLength(1);
  });

  it("rejects a stale aftersale proposal after an ordinary application without adding a second application", async () => {
    const target = await order();
    await command("payOrder", [target], () => commerceApi.payOrder(target));
    const run = await running(),
      paid = readDatabase(sql).orders.find((o) => o.id === target)!,
      lines = [{ orderItemId: paid.items[0]!.id, quantity: 1 }];
    const proposal = asUser(() =>
      createSupportProposal(sql, run, {
        kind: "requestAfterSale",
        orderId: target,
        reason: "质量问题",
        description: "原客服提案",
        lines,
      }),
    );
    await command(
      "requestAfterSale",
      [target, "质量问题", "通过普通入口申请", lines],
      () =>
        commerceApi.requestAfterSale(
          target,
          "质量问题",
          "通过普通入口申请",
          lines,
        ),
    );
    sql
      .prepare("UPDATE support_runs SET status='completed' WHERE id=?")
      .run(run.id);
    await expect(confirm(proposal.id)).rejects.toMatchObject({
      status: 409,
      code: "PROPOSAL_STALE",
    });
    expect(
      readDatabase(sql).afterSales.filter((sale) => sale.orderId === target),
    ).toHaveLength(1);
    expect(
      sql
        .prepare("SELECT status FROM support_proposals WHERE id=?")
        .get(proposal.id)?.status,
    ).toBe("pending");
  });

  it("denies access to a real foreign order and strips private data from owned order tools", async () => {
    const mine = await order(),
      foreign = await order(1, "u2"),
      run = await running();
    const evidence = {
      sources: [],
      products: new Set<string>(),
      orders: new Set<string>(),
      degraded: [],
    };
    const result = await asUser(() =>
      executeSupportTool(
        sql,
        run,
        "order_details",
        { orderId: mine },
        new AbortController().signal,
        evidence,
      ),
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(
      /"(?:userId|address|phone|recipient|password|passwordHash|note|giftMessage)"/,
    );
    await expect(
      asUser(() =>
        executeSupportTool(
          sql,
          run,
          "order_details",
          { orderId: foreign },
          new AbortController().signal,
          evidence,
        ),
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(evidence.orders.has(foreign)).toBe(false);
    expect(() =>
      asUser(() =>
        createSupportProposal(sql, run, {
          kind: "cancelOrder",
          orderId: foreign,
        }),
      ),
    ).toThrow("不属于当前用户");
    expect(
      sql.prepare("SELECT count(*) AS n FROM support_proposals").get()?.n,
    ).toBe(0);
  });

  it("never persists a provider answer that resolves after the task deadline", async () => {
    vi.useFakeTimers();
    const run = await running();
    sql
      .prepare("UPDATE support_runs SET deadline=? WHERE id=?")
      .run(Date.now() + 1000, run.id);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const work = processSupportRun(sql, run.id, async () => {
      await gate;
      return {
        role: "assistant",
        content: JSON.stringify({
          answer: "超时后到达的回答",
          citations: [],
          productIds: [],
        }),
      };
    });
    await vi.advanceTimersByTimeAsync(1001);
    release();
    await work;
    expect(
      sql
        .prepare("SELECT status,error FROM support_runs WHERE id=?")
        .get(run.id),
    ).toEqual({ status: "failed", error: "AI_TIMEOUT" });
    expect(
      readDatabase(sql)
        .conversations.find((c) => c.id === run.conversation_id)!
        .messages.some((message) => message.text === "超时后到达的回答"),
    ).toBe(false);
  });

  it("enforces the global queue bound for failed-task retries", async () => {
    vi.stubEnv("AI_MAX_CONCURRENT", "1");
    vi.stubEnv("AI_MAX_QUEUE", "1");
    const retry = await running();
    sql
      .prepare(
        "UPDATE support_runs SET status='failed',error='AI_TIMEOUT' WHERE id=?",
      )
      .run(retry.id);
    for (const uid of ["u2", "u3"]) {
      const other = await running(uid);
      sql
        .prepare("UPDATE support_runs SET status='queued' WHERE id=?")
        .run(other.id);
    }
    await expect(
      command("retrySupportRun", [retry.id], () =>
        supportCommands.retrySupportRun(retry.id),
      ),
    ).rejects.toMatchObject({ status: 429 });
    expect(
      sql.prepare("SELECT status FROM support_runs WHERE id=?").get(retry.id)
        ?.status,
    ).toBe("failed");
  });

  it("creates a confirmable fresh proposal on explicit retry instead of returning the cancelled previous attempt", async () => {
    const run = await running(),
      input = {
        kind: "addCart" as const,
        productId: "p01",
        skuId: "p01-s1",
        quantity: 1,
      },
      first = asUser(() => createSupportProposal(sql, run, input));
    sql
      .prepare(
        "UPDATE support_runs SET status='failed',error='AI_PROVIDER_FAILED' WHERE id=?",
      )
      .run(run.id);
    sql
      .prepare("UPDATE support_proposals SET status='cancelled' WHERE id=?")
      .run(first.id);
    await command("retrySupportRun", [run.id], () =>
      supportCommands.retrySupportRun(run.id),
    );
    sql
      .prepare("UPDATE support_runs SET status='running' WHERE id=?")
      .run(run.id);
    const next = asUser(() => createSupportProposal(sql, run, input));
    expect(next.id).not.toBe(first.id);
    expect(
      sql
        .prepare("SELECT status FROM support_proposals WHERE id=?")
        .get(next.id)?.status,
    ).toBe("pending");
    sql
      .prepare("UPDATE support_runs SET status='completed' WHERE id=?")
      .run(run.id);
    await confirm(next.id);
    expect(
      sql
        .prepare("SELECT status FROM support_proposals WHERE id=?")
        .get(next.id)?.status,
    ).toBe("confirmed");
    expect(
      sql
        .prepare("SELECT status FROM support_proposals WHERE id=?")
        .get(first.id)?.status,
    ).toBe("cancelled");
  });
});
