import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createSeed } from "../../shared/domain/seed";
import { openDatabase, readDatabase, writeDatabase } from "../src/database";
import { context } from "../src/repository";
import { supportApi } from "../src/support";
import { ensureRuntimeSchema } from "../src/runtime";

let sql: DatabaseSync;
function command<T>(method: string, args: unknown[], work: () => T) {
  return context.run(
    {
      sql,
      user: { id: "u1", name: "测试顾客", role: "user" },
      admin: null,
      command: {
        method,
        args,
        requestId: crypto.randomUUID(),
        fingerprint: JSON.stringify(args),
      },
    },
    work,
  );
}
async function chat(withProduct = false) {
  const input = withProduct ? { productId: "p01" } : {};
  return command("createConversation", [input], () =>
    supportApi.createConversation(input),
  );
}
async function send(id: string, message: string) {
  await command("sendMessage", [id, message], () =>
    supportApi.sendMessage(id, message),
  );
  return readDatabase(sql)
    .conversations.find((c) => c.id === id)!
    .messages.at(-1)!;
}
beforeEach(() => {
  vi.stubEnv("AI_ENABLED", "false");
  sql = openDatabase(":memory:");
  ensureRuntimeSchema(sql);
  const seed = createSeed(),
    product = seed.products.find((p) => p.id === "p01")!,
    template = seed.orders[0]!;
  product.skus[0]!.stock = 3;
  product.skus[1]!.stock = 0;
  seed.products = [product];
  seed.faqs = [];
  seed.orders = [
    {
      ...structuredClone(template),
      id: "reserved-by-another-user",
      userId: "u2",
      status: "pending",
      inventoryPolicy: "reserved-v1",
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      items: [
        {
          ...structuredClone(template.items[0]!),
          id: "reservation-line",
          productId: product.id,
          skuId: product.skus[0]!.id,
          quantity: 2,
        },
      ],
    },
  ];
  writeDatabase(sql, seed);
});
afterEach(() => {
  sql.close();
  vi.unstubAllEnvs();
});

it("reports sellable stock after another customer's pending reservation", async () => {
  const id = await chat(true),
    answer = await send(id, "还有多少库存？");
  expect(answer.text).toContain("可售库存 1");
  expect(answer.text).toContain("可售库存 0");
  expect(answer.productIds).toEqual(["p01"]);
  expect(readDatabase(sql).products[0]!.skus[0]!.stock).toBe(3);
});

it("recommends remaining sellable goods but excludes goods fully reserved by pending orders", async () => {
  const id = await chat(),
    available = await send(id, "推荐无线头戴耳机");
  expect(available.productIds).toEqual(["p01"]);
  const db = readDatabase(sql);
  db.orders[0]!.items[0]!.quantity = 3;
  writeDatabase(sql, db);
  const soldOut = await send(id, "推荐无线头戴耳机");
  expect(soldOut.productIds ?? []).toEqual([]);
  expect(soldOut.text).toContain("转人工");
});

it("gives customers a usable human-handoff instruction and keeps accepting their follow-up", async () => {
  const id = await chat();
  await command("transferConversation", [id], () =>
    supportApi.transferConversation(id),
  );
  const conversation = readDatabase(sql).conversations.find(
    (c) => c.id === id,
  )!;
  expect(conversation.status).toBe("waiting");
  expect(conversation.messages.at(-1)!.text).toContain("演示人工服务队列");
  expect(conversation.messages.at(-1)!.text).toContain("继续补充问题");
  expect(conversation.messages.at(-1)!.text).not.toContain("管理端");
  const last = await send(id, "补充：我想确认包装是否破损");
  expect(last.role).toBe("user");
  expect(last.text).toContain("包装是否破损");
  expect(readDatabase(sql).conversations.find((c) => c.id === id)!.status).toBe(
    "waiting",
  );
});
