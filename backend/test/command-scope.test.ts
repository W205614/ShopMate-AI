import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import type { Session } from "../../shared/domain/types";
import { createSeed } from "../../shared/domain/seed";
import {
  openDatabase,
  readDatabase,
  writeDatabase,
  queryRecord,
} from "../src/database";
import { commandReadScope, context } from "../src/repository";
import { ensureRuntimeSchema } from "../src/runtime";
import { commerceApi } from "../src/commerce";
import { marketingApi } from "../src/marketing";
import { supportApi } from "../src/support";

let sql: DatabaseSync;
const user: Session = { id: "u1", name: "member", role: "user" };
const admin: Session = {
  id: "admin",
  name: "owner",
  role: "admin",
  staffRole: "owner",
};
function command(method: string, args: unknown[]) {
  return {
    method,
    args,
    requestId: crypto.randomUUID(),
    fingerprint: JSON.stringify(args),
  };
}
function run<T>(
  method: string,
  args: unknown[],
  work: () => Promise<T>,
  asAdmin = false,
) {
  return context.run(
    {
      sql,
      user: asAdmin ? null : user,
      admin: asAdmin ? admin : null,
      command: command(method, args),
    },
    work,
  );
}
beforeEach(() => {
  sql = openDatabase(":memory:");
  writeDatabase(sql, createSeed());
  ensureRuntimeSchema(sql);
});
afterEach(() => {
  vi.restoreAllMocks();
  sql.close();
});

describe("command-specific order scope", () => {
  it("updates a cart without parsing or rewriting 10000 completed owner orders while respecting global reservations", async () => {
    const seed = createSeed(),
      base = seed.orders[0]!;
    seed.orders = Array.from({ length: 10000 }, (_, index) => {
      const id = `history-${index}`;
      return {
        ...structuredClone(base),
        id,
        userId: "u1",
        status: "completed" as const,
        completedAt: new Date().toISOString(),
        items: base.items.map((item, line) => ({
          ...item,
          id: `${id}-line-${line}`,
        })),
        events: [
          {
            at: new Date().toISOString(),
            actor: "system" as const,
            action: "HISTORY_ONLY_ORDER_DO_NOT_LOAD",
          },
        ],
      };
    });
    const reservation = {
      ...structuredClone(base),
      id: "global-reservation",
      userId: "u2",
      status: "pending" as const,
      inventoryPolicy: "reserved-v1" as const,
      expiresAt: new Date(Date.now() + 1800000).toISOString(),
      items: base.items.map((item, line) => ({
        ...item,
        id: `reservation-line-${line}`,
        quantity: 1,
      })),
    };
    seed.orders.push(reservation);
    seed.carts = [
      {
        id: "cart-target",
        userId: "u1",
        productId: base.items[0]!.productId,
        skuId: base.items[0]!.skuId,
        quantity: 1,
        selected: true,
      },
    ];
    writeDatabase(sql, seed);
    const scope = commandReadScope(
      sql,
      command("updateCart", ["cart-target", { quantity: 2 }]),
      user,
    );
    expect(scope.userId).toBeUndefined();
    expect(scope.orderIds).toEqual([]);
    expect(readDatabase(sql, scope).orders.map((order) => order.id)).toEqual([
      "global-reservation",
    ]);
    sql.exec(
      "CREATE TEMP TABLE order_updates(id TEXT); CREATE TEMP TRIGGER watch_orders AFTER UPDATE ON biz_orders BEGIN INSERT INTO order_updates VALUES(new.key); END;",
    );
    const parse = JSON.parse;
    vi.spyOn(JSON, "parse").mockImplementation((value, reviver) => {
      if (value.includes("HISTORY_ONLY_ORDER_DO_NOT_LOAD"))
        throw new Error("unrelated historical order was parsed");
      return parse(value, reviver);
    });
    await run("updateCart", ["cart-target", { quantity: 2 }], () =>
      commerceApi.updateCart("cart-target", { quantity: 2 }),
    );
    const stock = seed.products
      .find((product) => product.id === base.items[0]!.productId)!
      .skus.find((sku) => sku.id === base.items[0]!.skuId)!.stock;
    await expect(
      run("updateCart", ["cart-target", { quantity: stock }], () =>
        commerceApi.updateCart("cart-target", { quantity: stock }),
      ),
    ).rejects.toThrow("不能超过库存");
    expect(
      queryRecord<{ quantity: number }>(sql, "carts", "cart-target")?.quantity,
    ).toBe(2);
    expect(
      sql
        .prepare(
          "SELECT count(*) AS n FROM biz_orders WHERE status='completed'",
        )
        .get(),
    ).toEqual({ n: 10000 });
    expect(
      sql.prepare("SELECT count(*) AS n FROM order_updates").get(),
    ).toEqual({ n: 0 });
  }, 30000);

  it("loads explicit historical purchases for pay replay, reorder, review and after-sale commands", async () => {
    const seed = createSeed(),
      order = seed.orders[0]!,
      item = order.items[0]!;
    order.userId = "u1";
    order.status = "completed";
    order.completedAt = new Date().toISOString();
    writeDatabase(sql, seed);
    await run("payOrder", [order.id], () => commerceApi.payOrder(order.id));
    expect(
      (await run("reorder", [order.id], () => commerceApi.reorder(order.id)))
        .added,
    ).toBeGreaterThan(0);
    const reviewInput = {
      orderId: order.id,
      orderItemId: item.id,
      rating: 5,
      content: "这是一个完整的购买评价",
    };
    await run("submitReview", [reviewInput], () =>
      marketingApi.submitReview(reviewInput),
    );
    const review = readDatabase(sql).reviews[0]!;
    await run(
      "moderateReview",
      [review.id, true],
      () => marketingApi.moderateReview(review.id, true),
      true,
    );
    expect(
      queryRecord<{ hidden: boolean }>(sql, "reviews", review.id)?.hidden,
    ).toBe(true);
    const lines = [{ orderItemId: item.id, quantity: 1 }];
    await run(
      "requestAfterSale",
      [order.id, "退货", "测试售后说明", lines],
      () =>
        commerceApi.requestAfterSale(order.id, "退货", "测试售后说明", lines),
    );
    const sale = readDatabase(sql).afterSales.find(
      (value) => value.orderId === order.id,
    )!;
    await run("cancelAfterSale", [sale.id], () =>
      commerceApi.cancelAfterSale(sale.id),
    );
    expect(
      queryRecord<{ status: string }>(sql, "afterSales", sale.id)?.status,
    ).toBe("cancelled");
    const foreign = seed.orders.find((value) => value.userId === "u2")!;
    await expect(
      run("reorder", [foreign.id], () => commerceApi.reorder(foreign.id)),
    ).rejects.toThrow("不属于");
  });

  it("resolves old order-request and quote bindings for checkout replay and retirement", async () => {
    const seed = createSeed(),
      order = seed.orders[0]!;
    order.userId = "u1";
    order.status = "completed";
    order.completedAt = new Date().toISOString();
    seed.orderRequests = [
      {
        userId: "u1",
        requestId: "old-domain-request",
        quoteId: "old-quote",
        orderId: order.id,
        createdAt: new Date().toISOString(),
      },
    ];
    writeDatabase(sql, seed);
    const old = { quoteId: "old-quote", requestId: "old-domain-request" };
    expect(
      commandReadScope(sql, command("createOrder", [old]), user).orderIds,
    ).toEqual([order.id]);
    expect(
      await run("createOrder", [old], () => commerceApi.createOrder(old)),
    ).toBe(order.id);
    const input = {
      addressId: "a1",
      source: {
        type: "buyNow" as const,
        productId: "p02",
        skuId: "p02-s1",
        quantity: 1,
      },
    };
    const quote = await run("quoteCheckout", [input], () =>
      commerceApi.quoteCheckout(input),
    );
    const changed = readDatabase(sql);
    changed.checkoutQuotes.find((value) => value.id === quote.id)!.orderId =
      order.id;
    writeDatabase(sql, changed);
    const replay = { quoteId: quote.id, requestId: "fresh-domain-request" };
    expect(
      await run("createOrder", [replay], () => commerceApi.createOrder(replay)),
    ).toBe(order.id);
    const retire = { quoteId: quote.id, requestId: "retire-key" };
    expect(
      await run("retireCheckout", [retire], () =>
        commerceApi.retireCheckout(retire),
      ),
    ).toBe(order.id);
    const jobs = sql
      .prepare("SELECT payload FROM job_queue WHERE kind='notification'")
      .all() as { payload: string }[];
    expect(
      jobs.filter((job) => JSON.parse(job.payload).orderId === order.id),
    ).toHaveLength(2);
  });

  it("keeps conversation linked-order and first-owned-order fallback behavior", async () => {
    const seed = createSeed(),
      order = seed.orders[0]!;
    order.status = "completed";
    order.userId = "u1";
    order.completedAt = new Date().toISOString();
    writeDatabase(sql, seed);
    const input = { orderId: order.id },
      linked = await run("createConversation", [input], () =>
        supportApi.createConversation(input),
      );
    await run("sendMessage", [linked, "订单进度"], () =>
      supportApi.sendMessage(linked, "订单进度"),
    );
    expect(
      queryRecord<{ messages: { orderId?: string }[] }>(
        sql,
        "conversations",
        linked,
      )?.messages.at(-1)?.orderId,
    ).toBe(order.id);
    const fallback = await run("createConversation", [{}], () =>
      supportApi.createConversation({}),
    );
    await run("sendMessage", [fallback, "查看物流"], () =>
      supportApi.sendMessage(fallback, "查看物流"),
    );
    expect(
      queryRecord<{ messages: { orderId?: string }[] }>(
        sql,
        "conversations",
        fallback,
      )?.messages.at(-1)?.orderId,
    ).toBe(order.id);
  });
});
