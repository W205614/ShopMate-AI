import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createSeed } from "../../shared/domain/seed";
import { openDatabase, readDatabase, writeDatabase } from "../src/database";
import { context } from "../src/repository";
import { supportApi } from "../src/support";
import { ensureSupportSchema } from "../src/ai/ai-schema";
import { ensureKnowledgeSchema } from "../src/ai/ai-knowledge";
import {
  createSupportProposal,
  executeSupportTool,
  processSupportRun,
  supportCommands,
} from "../src/ai/ai-support";
import { renderGroundedAnswer } from "../src/ai/ai-answer";
import { migrateDatabase } from "../src/migration";
import { setStock } from "./support/warehouse-fixture";
import { stockRow } from "../src/warehouse-stock";

type Run = Parameters<typeof executeSupportTool>[1];
let sql: DatabaseSync;
const asUser = <T>(work: () => T) =>
  context.run(
    { sql, user: { id: "u1", name: "顾客", role: "user" }, admin: null },
    work,
  );
async function queued(orderId?: string, message = "请查询订单") {
  const id = await asUser(() => supportApi.createConversation({ orderId }));
  await asUser(() => supportApi.sendMessage(id, message));
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
  migrateDatabase(seed);
  writeDatabase(sql, seed);
  ensureSupportSchema(sql);
  ensureKnowledgeSchema(sql);
});
afterEach(() => {
  sql.close();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it("acknowledges an AI cancellation with a payment hold without reporting completion", async () => {
  const db = readDatabase(sql);
  const order = db.orders.find((item) => item.id === "owned-order")!;
  order.paymentHold = true;
  order.transactionMode = "production";
  writeDatabase(sql, db);
  const run = await queued(order.id, "取消订单");
  sql
    .prepare("UPDATE support_runs SET status='running' WHERE id=?")
    .run(run.id);
  const proposal = asUser(() =>
    createSupportProposal(sql, run, {
      kind: "cancelOrder",
      orderId: order.id,
    }),
  );
  expect(proposal.summary).toContain("等待渠道关单");
  sql
    .prepare("UPDATE support_runs SET status='completed' WHERE id=?")
    .run(run.id);
  for (let attempt = 0; attempt < 2; attempt++)
    await expect(
      asUser(() => supportCommands.confirmSupportProposal(proposal.id)),
    ).resolves.toMatchObject({ cancellation: "closing" });
  const saved = readDatabase(sql);
  expect(saved.orders.find((item) => item.id === order.id)).toMatchObject({
    status: "pending",
    cancelRequested: true,
    paymentHold: true,
  });
  expect(
    saved.conversations
      .find((c) => c.id === run.conversation_id)!
      .messages.at(-1)?.text,
  ).toContain("正在确认渠道关单");
  const notifications = sql
    .prepare("SELECT payload FROM job_queue WHERE kind='notification'")
    .all();
  expect(notifications).toHaveLength(1);
  expect(String(notifications[0]!.payload)).not.toContain("订单已取消");
});

it("renders a policy exception and rejects a quote that removes its negation", () => {
  const source = {
    id: "policy-test",
    title: "合成退货政策",
    text: "普通商品可以申请退货。定制商品不支持无理由退货。",
  };
  const answer = (text: string) =>
    renderGroundedAnswer({
      kind: "grounded",
      presentation: { sourceQuotes: [{ sourceId: source.id, text }] },
      sources: [source],
      products: [],
      afterSales: [],
      proposals: [],
    });
  expect(answer("定制商品不支持无理由退货。")).toContain(
    "定制商品不支持无理由退货。",
  );
  expect(() => answer("支持无理由退货。")).toThrow("AI_INVALID_SOURCE_QUOTE");
});

it.each([10000, 8000])(
  "grounds recommendations in an available SKU within %i cents",
  async (budget) => {
    const db = readDatabase(sql);
    const product = db.products.find((p) => p.id === "p01")!;
    const sku = product.skus[1]!;
    product.skus[0]!.price = 7_000;
    sku.price = 8_900;
    setStock(db, product.id, product.skus[0]!.id, 0);
    setStock(db, product.id, sku.id, 3);
    writeDatabase(sql, db);
    const run = await queued(
      undefined,
      `推荐${budget / 100}元以内有货的${product.name}`,
    );
    const caller = vi
      .fn()
      .mockResolvedValueOnce({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "recommend-search",
            type: "function",
            function: {
              name: "search_products",
              arguments: JSON.stringify({
                query: product.name,
                // A mistaken model-provided limit must not replace the customer limit.
                maxPrice: 100_000,
              }),
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        role: "assistant",
        content: JSON.stringify({
          replyKind: budget >= sku.price ? "grounded" : "handoff",
          answer: "请看结果。",
          productIds: budget >= sku.price ? [product.id] : [],
          presentation: { productView: "details" },
        }),
      });
    await processSupportRun(sql, run.id, caller);
    const answer = readDatabase(sql)
      .conversations.find((c) => c.id === run.conversation_id)!
      .messages.at(-1)!;
    if (budget >= sku.price) {
      expect(answer.recommendations).toEqual([
        {
          productId: product.id,
          productName: product.name,
          skuId: sku.id,
          skuName: sku.name,
          price: 8900,
          reason: product.description,
        },
      ]);
    } else {
      expect(answer.recommendations).toBeUndefined();
      expect(answer.text).toContain("要放宽预算，还是调整选购条件");
    }
  },
);

it("asks only for the missing shopping budget", async () => {
  const run = await queued(undefined, "想买适合通勤的耳机，请先问我预算");
  await processSupportRun(sql, run.id, async () => ({
    role: "assistant",
    content: JSON.stringify({
      replyKind: "clarify",
      answer: "请补充预算。",
    }),
  }));
  expect(
    readDatabase(sql)
      .conversations.find((c) => c.id === run.conversation_id)!
      .messages.at(-1)?.text,
  ).toBe("请补充预算。");
});

it("uses verified budget and delivery facts when the model wrongly hands off an available recommendation", async () => {
  const db = readDatabase(sql);
  const product = db.products.find((entry) => entry.id === "p01")!;
  product.skus[0]!.price = 5900;
  product.skus[1]!.price = 6900;
  db.warehouses![0]!.provinces = ["上海市"];
  db.warehouses!.push({
    id: "fixture-south",
    name: "验收华南仓",
    priority: 1,
    provinces: ["广东省"],
    acceptsOrders: true,
    version: 1,
  });
  stockRow(db, "fixture-south", product.id, product.skus[1]!.id).onHand = 2;
  product.skus[1]!.stock += 2;
  writeDatabase(sql, db);
  const run = await queued(
    undefined,
    `推荐可寄到广东省的${product.name}，预算75元。`,
  );
  const caller = vi
    .fn()
    .mockResolvedValueOnce({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "regional-search",
          type: "function",
          function: {
            name: "search_products",
            arguments: JSON.stringify({ query: product.name }),
          },
        },
      ],
    })
    .mockResolvedValueOnce({
      role: "assistant",
      content: JSON.stringify({
        replyKind: "handoff",
        answer: "无货，建议联系人工。",
        productIds: [product.id],
      }),
    });
  await processSupportRun(sql, run.id, caller);
  const answer = readDatabase(sql)
    .conversations.find((entry) => entry.id === run.conversation_id)!
    .messages.at(-1)!;
  expect(answer.replyKind).toBe("grounded");
  expect(answer.recommendations).toEqual([
    expect.objectContaining({ skuId: product.skus[1]!.id, price: 6900 }),
  ]);
  expect(answer.text).not.toContain("没有找到有货商品");
});

it.each([
  ["预算75元", true],
  ["预算50到75元", true],
  ["最多2件", false],
] as const)(
  "applies a price limit only when the customer states a budget: %s",
  async (constraint, limited) => {
    const db = readDatabase(sql);
    const product = db.products.find((p) => p.id === "p01")!;
    const [under, over] = product.skus;
    Object.assign(under!, { price: 6_900, stock: 3 });
    Object.assign(over!, { price: 7_900, stock: 3 });
    writeDatabase(sql, db);
    const run = await queued(undefined, `推荐${constraint}的${product.name}`);
    const caller = vi
      .fn()
      .mockResolvedValueOnce({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "details",
            type: "function",
            function: {
              name: "product_details",
              arguments: JSON.stringify({ productId: product.id }),
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        role: "assistant",
        content: JSON.stringify({
          answer: "规格见结果",
          productIds: [product.id],
          presentation: { productView: "details" },
        }),
      });
    await processSupportRun(sql, run.id, caller);
    const answer = readDatabase(sql)
      .conversations.find((c) => c.id === run.conversation_id)!
      .messages.at(-1)!;
    expect(answer.text).toContain(under!.name);
    if (limited) {
      expect(answer.text).not.toContain(over!.name);
      expect(answer.recommendations).toEqual([
        expect.objectContaining({ skuId: under!.id, price: 6_900 }),
      ]);
    } else {
      expect(answer.text).toContain(over!.name);
      expect(answer.recommendations).toBeUndefined();
    }
  },
);

it("sends a minimized order and redacts contact details before calling the model", async () => {
  const db = readDatabase(sql);
  db.orders.find((order) => order.id === "owned-order")!.tracking =
    "PRIVATE-SYNTHETIC-TRACK";
  writeDatabase(sql, db);
  const message =
    "请查订单，邮箱 sample@example.test，手机号 138 1234 9876，收件地址：合成街1号。";
  const run = await queued("owned-order", message);
  const caller = vi.fn(async (_messages: unknown[]) => ({
    role: "assistant" as const,
    content: JSON.stringify({ answer: "订单状态", orderId: "owned-order" }),
  }));
  await processSupportRun(sql, run.id, caller);
  const payload = JSON.stringify(caller.mock.calls[0]![0]);
  expect(payload).toContain("owned-order");
  for (const value of [
    "sample@example.test",
    "138 1234 9876",
    "合成街1号",
    "PRIVATE-SYNTHETIC-TRACK",
  ])
    expect(payload).not.toContain(value);
  const saved = readDatabase(sql).conversations.find(
    (c) => c.id === run.conversation_id,
  )!;
  expect(saved.messages.some((item) => item.text === message)).toBe(true);
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
