import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createSeed } from "../../shared/domain/seed";
import { openDatabase, readDatabase, writeDatabase } from "../src/database";
import { context } from "../src/repository";
import { supportApi } from "../src/support";
import { ensureSupportSchema } from "../src/ai-schema";
import { ensureKnowledgeSchema } from "../src/ai-knowledge";
import { executeSupportTool, processSupportRun } from "../src/ai-support";

type Run = Parameters<typeof executeSupportTool>[1];
let sql: DatabaseSync;
const asUser = <T>(work: () => T) =>
  context.run(
    { sql, user: { id: "u1", name: "顾客", role: "user" }, admin: null },
    work,
  );
async function queued(orderId?: string) {
  const id = await asUser(() => supportApi.createConversation({ orderId }));
  await asUser(() => supportApi.sendMessage(id, "请查询订单"));
  return sql
    .prepare("SELECT * FROM support_runs WHERE conversation_id=?")
    .get(id) as Run;
}
const evidence = () => ({
  sources: [],
  products: new Set<string>(),
  productCaps: new Map<string, number | undefined>(),
  orders: new Set<string>(),
  degraded: [],
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-18T13:00:00.000Z"));
  vi.stubEnv("AI_ENABLED", "true");
  vi.stubEnv("LLM_API_KEY", "synthetic-no-network");
  sql = openDatabase(":memory:");
  const seed = createSeed(),
    template = seed.orders[0]!;
  seed.orders = [
    {
      ...structuredClone(template),
      id: "owned-order",
      userId: "u1",
      status: "pending",
      inventoryPolicy: "reserved-v1",
      createdAt: "2026-10-18T16:11:50.000Z",
      expiresAt: "2026-10-18T16:41:50.000Z",
    },
    {
      ...structuredClone(template),
      id: "foreign-order",
      userId: "u2",
      items: template.items.map((item) => ({
        ...item,
        id: `foreign-${item.id}`,
      })),
    },
  ];
  writeDatabase(sql, seed);
  ensureSupportSchema(sql);
  ensureKnowledgeSchema(sql);
});
afterEach(() => {
  sql.close();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it("supplies unambiguous Beijing dates for both owned-order tools, including a UTC day rollover", async () => {
  const run = await queued();
  const invoke = (name: string, input: unknown) =>
    asUser(() =>
      executeSupportTool(
        sql,
        run,
        name,
        input,
        new AbortController().signal,
        evidence(),
      ),
    );
  const result = await invoke("order_details", { orderId: "owned-order" });
  const expected = {
    id: "owned-order",
    createdAt: "2026-10-18T16:11:50.000Z",
    expiresAt: "2026-10-18T16:41:50.000Z",
    timeZone: "Asia/Shanghai",
    createdAtDisplay: "2026-10-19 00:11:50（北京时间，Asia/Shanghai）",
    expiresAtDisplay: "2026-10-19 00:41:50（北京时间，Asia/Shanghai）",
  };
  expect(result).toMatchObject(expected);
  expect(await invoke("my_orders", {})).toEqual([
    expect.objectContaining(expected),
  ]);
});

it("includes formatted local time in verified order context and tells the model to retain its timezone", async () => {
  const run = await queued("owned-order");
  const caller = vi.fn(async (rawMessages: unknown[]) => {
    const messages = rawMessages as {
      role: string;
      name?: string;
      content: unknown;
    }[];
    expect(messages.find((m) => m.role === "system")!.content).toContain(
      "展示时间必须注明时区",
    );
    expect(
      messages.find((m) => m.name === "server_context")!.content,
    ).toContain("2026-10-19 00:11:50（北京时间，Asia/Shanghai）");
    return {
      role: "assistant" as const,
      content: JSON.stringify({
        answer: "请核对订单信息。",
        orderId: "owned-order",
      }),
    };
  });
  await processSupportRun(sql, run.id, caller);
  expect(caller).toHaveBeenCalledTimes(1);
  expect(
    sql.prepare("SELECT status FROM support_runs WHERE id=?").get(run.id)
      ?.status,
  ).toBe("completed");
});

it("accepts a final order card grounded in a successful owned-order proposal without a separate order lookup", async () => {
  const run = await queued();
  const caller = vi
    .fn()
    .mockResolvedValueOnce({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "cancel-1",
          type: "function",
          function: {
            name: "propose_action",
            arguments: JSON.stringify({
              kind: "cancelOrder",
              orderId: "owned-order",
            }),
          },
        },
      ],
    })
    .mockResolvedValueOnce({
      role: "assistant",
      content: JSON.stringify({
        answer: "请核对取消订单卡片后确认。",
        orderId: "owned-order",
      }),
    });
  await processSupportRun(sql, run.id, caller);
  expect(
    sql.prepare("SELECT status FROM support_runs WHERE id=?").get(run.id)
      ?.status,
  ).toBe("completed");
  expect(
    sql
      .prepare("SELECT status FROM support_proposals WHERE run_id=?")
      .get(run.id)?.status,
  ).toBe("pending");
  expect(
    readDatabase(sql).orders.find((o) => o.id === "owned-order")!.status,
  ).toBe("pending");
});

it("never registers a foreign order as evidence when its proposal fails ownership checks", async () => {
  const run = await queued();
  sql
    .prepare("UPDATE support_runs SET status='running' WHERE id=?")
    .run(run.id);
  const verified = evidence();
  await expect(
    asUser(() =>
      executeSupportTool(
        sql,
        run,
        "propose_action",
        {
          kind: "cancelOrder",
          orderId: "foreign-order",
        },
        new AbortController().signal,
        verified,
      ),
    ),
  ).rejects.toThrow("不属于当前用户");
  expect(verified.orders.size).toBe(0);
  expect(
    sql.prepare("SELECT count(*) AS n FROM support_proposals").get()?.n,
  ).toBe(0);
});

it("accepts a product card grounded in a successful add-to-cart proposal without executing it", async () => {
  const run = await queued(),
    cartBefore = readDatabase(sql).carts;
  const caller = vi
    .fn()
    .mockResolvedValueOnce({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "cart-1",
          type: "function",
          function: {
            name: "propose_action",
            arguments: JSON.stringify({
              kind: "addCart",
              productId: "p01",
              skuId: "p01-s1",
              quantity: 1,
            }),
          },
        },
      ],
    })
    .mockResolvedValueOnce({
      role: "assistant",
      content: JSON.stringify({
        answer: "请核对商品卡片后确认加购。",
        productIds: ["p01"],
      }),
    });
  await processSupportRun(sql, run.id, caller);
  expect(
    sql.prepare("SELECT status FROM support_runs WHERE id=?").get(run.id)
      ?.status,
  ).toBe("completed");
  expect(
    sql
      .prepare("SELECT status FROM support_proposals WHERE run_id=?")
      .get(run.id)?.status,
  ).toBe("pending");
  expect(readDatabase(sql).carts).toEqual(cartBefore);
});
