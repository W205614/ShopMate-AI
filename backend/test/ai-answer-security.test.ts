import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createSeed } from "../../shared/domain/seed";
import { openDatabase, readDatabase, writeDatabase } from "../src/database";
import { context } from "../src/repository";
import { supportApi } from "../src/support";
import {
  processSupportRun,
  supportCommands,
  createSupportProposal,
} from "../src/ai-support";
import {
  handoffReply,
  clarificationReply,
  renderGroundedAnswer,
} from "../src/ai-answer";
import { reserveProviderRequest } from "../src/ai-budget";
import { ensureKnowledgeSchema } from "../src/ai-knowledge";

let sql: DatabaseSync;
const asUser = <T>(work: () => T) =>
  context.run(
    { sql, user: { id: "u1", name: "顾客", role: "user" }, admin: null },
    work,
  );
async function queued(productId?: string) {
  const conversation = await asUser(() =>
    supportApi.createConversation({ productId }),
  );
  await asUser(() =>
    supportApi.sendMessage(conversation, "请核对退货政策和商品事实"),
  );
  return sql
    .prepare(
      "SELECT id,conversation_id FROM support_runs WHERE conversation_id=?",
    )
    .get(conversation)!;
}
const last = (conversation: unknown) =>
  readDatabase(sql)
    .conversations.find((entry) => entry.id === conversation)!
    .messages.at(-1)!;
beforeEach(() => {
  vi.stubEnv("AI_ENABLED", "true");
  sql = openDatabase(":memory:");
  writeDatabase(sql, createSeed());
  ensureKnowledgeSchema(sql);
});
afterEach(() => {
  sql.close();
  vi.unstubAllEnvs();
});

it.each(["grounded", "handoff", "clarify", undefined])(
  "never displays unsupported policy text under reply kind %s",
  async (replyKind) => {
    const run = await queued();
    await processSupportRun(sql, String(run.id), async () => ({
      role: "assistant",
      content: JSON.stringify({
        replyKind,
        answer: "365天无条件退货，退款1秒到账",
        citations: [],
      }),
    }));
    expect(last(run.conversation_id).text).toBe(
      replyKind === "clarify" ? clarificationReply : handoffReply,
    );
    expect(last(run.conversation_id).text).not.toMatch(/365|1秒/);
  },
);

it("renders current server product facts instead of false numeric claims from the model", async () => {
  const run = await queued("p01");
  await processSupportRun(sql, String(run.id), async () => ({
    role: "assistant",
    content: JSON.stringify({
      replyKind: "grounded",
      answer: "价格为1分钱，库存999999件",
      productIds: ["p01"],
    }),
  }));
  const product = readDatabase(sql).products.find(
    (entry) => entry.id === "p01",
  )!;
  expect(last(run.conversation_id).text).toContain(product.material);
  expect(last(run.conversation_id).text).toContain(
    `${(product.skus[0]!.price / 100).toFixed(2)}元`,
  );
  expect(last(run.conversation_id).text).not.toMatch(/1分钱|999999/);
});

it("asks only for the specified missing fields while ignoring arbitrary model wording", async () => {
  const run = await queued("p01");
  await processSupportRun(sql, String(run.id), async () => ({
    role: "assistant",
    content: JSON.stringify({
      replyKind: "clarify",
      answer: "请重新提供订单和所有个人资料",
      presentation: { missingFields: ["sku", "quantity"] },
    }),
  }));
  expect(last(run.conversation_id).text).toContain("商品规格、购买数量");
  expect(last(run.conversation_id).text).not.toMatch(/订单|个人资料|售后原因/);
});

it("compares queried products with exact server prices and a computed price difference", async () => {
  const run = await queued("p01");
  let count = 0;
  await processSupportRun(sql, String(run.id), async () =>
    ++count === 1
      ? {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "second",
              type: "function",
              function: {
                name: "product_details",
                arguments: JSON.stringify({ productId: "p02" }),
              },
            },
          ],
        }
      : {
          role: "assistant",
          content: JSON.stringify({
            replyKind: "grounded",
            answer: "两件均只要1分钱",
            productIds: ["p01", "p02"],
            presentation: {
              productView: "compare",
              focus: ["price", "material"],
            },
          }),
        },
  );
  const answer = last(run.conversation_id);
  expect(answer.productIds).toEqual(["p01", "p02"]);
  expect(answer.text).toMatch(/商品对比/);
  expect(answer.text).toContain("价格取舍");
  expect(answer.text).toContain("相差120.00元");
  expect(answer.text).not.toContain("1分钱");
});

it("filters recommendation variants against search budget and current availability", async () => {
  const run = await queued();
  let count = 0;
  await processSupportRun(sql, String(run.id), async () =>
    ++count === 1
      ? {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "search",
              type: "function",
              function: {
                name: "search_products",
                arguments: JSON.stringify({ query: "耳机", maxPrice: 40000 }),
              },
            },
          ],
        }
      : {
          role: "assistant",
          content: JSON.stringify({
            replyKind: "grounded",
            answer: "假推荐理由",
            productIds: ["p01"],
            presentation: {
              productView: "recommend",
              focus: ["description", "price", "stock"],
            },
          }),
        },
  );
  expect(last(run.conversation_id).text).toContain("399.00元");
  expect(last(run.conversation_id).text).not.toMatch(/409.00元|假推荐理由/);
});

it("selects whole source sentences and rejects removing negations, conditions or numeric prefixes", () => {
  const base = {
    kind: "grounded" as const,
    sources: [
      {
        id: "policy",
        title: "政策",
        text: "定制款不支持无理由退货。\n商品实付满99元包邮，未满收取8元运费。",
      },
    ],
    products: [],
    afterSales: [],
    proposals: [],
  };
  expect(
    renderGroundedAnswer({
      ...base,
      presentation: {
        sourceQuotes: [
          { sourceId: "policy", text: "定制款不支持无理由退货。" },
        ],
      },
    }),
  ).not.toContain("99");
  for (const text of [
    "支持无理由退货。",
    "99元包邮，未满收取8元运费。",
    "包邮",
    "无条件退货",
  ])
    expect(() =>
      renderGroundedAnswer({
        ...base,
        presentation: { sourceQuotes: [{ sourceId: "policy", text }] },
      }),
    ).toThrow("AI_INVALID_SOURCE_QUOTE");
});

it("quotes published policy evidence without accepting a contradictory model paraphrase", async () => {
  const run = await queued();
  let calls = 0;
  await processSupportRun(sql, String(run.id), async (messages: unknown[]) => {
    calls++;
    if (calls === 1)
      return {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "knowledge",
            type: "function",
            function: {
              name: "search_knowledge",
              arguments: JSON.stringify({ query: "退换售后" }),
            },
          },
        ],
      };
    const response = JSON.parse(
      String((messages.at(-1) as { content: string }).content),
    );
    expect(response.sources.length).toBeGreaterThan(0);
    return {
      role: "assistant",
      content: JSON.stringify({
        replyKind: "grounded",
        answer: "无条件终身退款",
        citations: response.sources.map((source: { id: string }) => source.id),
      }),
    };
  });
  const answer = last(run.conversation_id);
  expect(answer.citations!.length).toBeGreaterThan(0);
  for (const source of answer.citations!)
    expect(answer.text).toContain(source.text);
  expect(answer.text).not.toContain("无条件终身退款");
});

it("counts consultation retries and rejects them before a new provider request", async () => {
  vi.stubEnv("AI_USER_DAILY_CONSULTATIONS", "1");
  const run = await queued();
  await processSupportRun(sql, String(run.id), async () => {
    throw new Error("synthetic failure");
  });
  await expect(
    asUser(() => supportCommands.retrySupportRun(String(run.id))),
  ).rejects.toMatchObject({ status: 429, code: "AI_USER_BUDGET_EXHAUSTED" });
  expect(
    sql.prepare("SELECT status FROM support_runs WHERE id=?").get(run.id)
      ?.status,
  ).toBe("failed");
});

it("reports global quota exhaustion without encouraging an immediate retry", async () => {
  vi.stubEnv("AI_DAILY_PROVIDER_CALLS", "1");
  reserveProviderRequest(sql);
  const run = await queued();
  await processSupportRun(sql, String(run.id), async () => {
    reserveProviderRequest(sql);
    throw new Error("unreachable");
  });
  expect(
    sql.prepare("SELECT error FROM support_runs WHERE id=?").get(run.id)?.error,
  ).toBe("AI_PROVIDER_BUDGET_EXHAUSTED");
  expect(last(run.conversation_id).text).toContain("次日");
});

it("confirms a proposal without parsing an unrelated account's conversation", async () => {
  const run = await queued("p01");
  sql
    .prepare("UPDATE support_runs SET status='running' WHERE id=?")
    .run(run.id);
  const record = sql
    .prepare("SELECT * FROM support_runs WHERE id=?")
    .get(run.id)!;
  const proposal = asUser(() =>
    createSupportProposal(
      sql,
      record as unknown as Parameters<typeof createSupportProposal>[1],
      { kind: "addCart", productId: "p01", skuId: "p01-s1", quantity: 1 },
    ),
  );
  sql
    .prepare("UPDATE support_runs SET status='completed' WHERE id=?")
    .run(run.id);
  const unrelated = JSON.stringify({
    id: "unrelated-scope-sentinel",
    userId: "u2",
    title: "private",
    status: "bot",
    createdAt: new Date().toISOString(),
    messages: [],
  });
  sql
    .prepare(
      "INSERT INTO biz_conversations(key,position,data) VALUES('unrelated-scope-sentinel',-100,?)",
    )
    .run(unrelated);
  const parse = JSON.parse;
  const spy = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
    if (String(text).includes("unrelated-scope-sentinel"))
      throw new Error("unrelated conversation was parsed");
    return parse(text, reviver);
  });
  try {
    const result = await context.run(
      {
        sql,
        user: { id: "u1", name: "顾客", role: "user" },
        admin: null,
        command: {
          method: "confirmSupportProposal",
          requestId: crypto.randomUUID(),
          fingerprint: "synthetic",
          args: [proposal.id],
        },
      },
      () => supportCommands.confirmSupportProposal(proposal.id),
    );
    expect(result.completed).toBe(true);
  } finally {
    spy.mockRestore();
  }
  expect(
    sql
      .prepare(
        "SELECT data FROM biz_conversations WHERE key='unrelated-scope-sentinel'",
      )
      .get()?.data,
  ).toBe(unrelated);
});
