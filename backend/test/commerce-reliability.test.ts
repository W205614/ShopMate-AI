import { beforeEach, describe, expect, it } from "vitest";
import { commerceApi, expirePendingOrders } from "../src/commerce";
import { catalogApi } from "../src/catalog";
import { marketingApi } from "../src/marketing";
import { context } from "../src/repository";
import { availableStock } from "../src/commerce-rules";
import { openDatabase, readDatabase, writeDatabase } from "../src/database";
import { createSeed } from "../../shared/domain/seed";
import type { Database, Session } from "../../shared/domain/types";
const sql = openDatabase(":memory:");
const services = { ...commerceApi, ...catalogApi, ...marketingApi };
const api = Object.fromEntries(
  Object.entries(services).map(([name, fn]) => [
    name,
    (...args: unknown[]) =>
      context.run(
        {
          sql,
          user: { id: "u1", name: "user", role: "user" },
          admin: { id: "admin", name: "admin", role: "admin" } as Session,
        },
        () => (fn as (...args: unknown[]) => Promise<unknown>)(...args),
      ),
  ]),
) as typeof services;
const db = () => readDatabase(sql);
function change(fn: (d: Database) => void) {
  const d = db();
  fn(d);
  writeDatabase(sql, d);
}
const input = (quantity = 1, couponClaimId?: string) => ({
  addressId: "a1",
  source: {
    type: "buyNow" as const,
    productId: "p01",
    skuId: "p01-s1",
    quantity,
  },
  ...(couponClaimId ? { couponClaimId } : {}),
});
async function order(quantity = 1) {
  const q = await api.quoteCheckout(input(quantity));
  return api.createOrder({ quoteId: q.id, requestId: crypto.randomUUID() });
}
const own = (id: string) => db().orders.find((o) => o.id === id)!;
async function refund(id: string, quantity: number, returned = false) {
  await api.requestAfterSale(id, "退款测试", "边界测试退款", [
    { orderItemId: own(id).items[0]!.id, quantity },
  ]);
  const sale = db().afterSales[0]!;
  await api.processAfterSale(sale.id, "approve");
  if (returned) {
    await api.submitReturn(sale.id, "物流", "TRACK");
    await api.processAfterSale(sale.id, "receive");
  }
  await api.processAfterSale(sale.id, "refund");
  return sale.id;
}
beforeEach(() => {
  writeDatabase(sql, createSeed());
});
describe("new commerce reliability policies", () => {
  it("snapshots a configured after-sale period without changing earlier orders", async () => {
    const first = await order();
    const quote = await api.quoteCheckout(input());
    const second = await context.run(
      {
        sql,
        user: { id: "u1", name: "user", role: "user" },
        admin: null,
        afterSaleDays: 14,
      },
      () =>
        commerceApi.createOrder({
          quoteId: quote.id,
          requestId: crypto.randomUUID(),
        }),
    );
    expect(own(first).afterSaleDays).toBe(7);
    expect(own(second).afterSaleDays).toBe(14);
  });
  it("reserves at commit, protects count, releases cancel once, and legacy payment cannot steal reserved stock", async () => {
    change((d) => {
      d.products[0]!.skus[0]!.stock = 2;
    });
    const legacy = await order(1);
    change((d) => {
      delete d.orders.find((o) => o.id === legacy)!.inventoryPolicy;
    });
    const reserved = await order(2);
    expect(availableStock(db(), "p01", "p01-s1")).toBe(0);
    await expect(api.quoteCheckout(input())).rejects.toThrow("库存不足");
    await expect(api.payOrder(legacy)).rejects.toThrow("库存不足");
    await expect(
      api.adjustStock("p01", "p01-s1", 0, 0, "盘点", {
        requestId: "count",
        mode: "count",
        expectedStock: 2,
      }),
    ).rejects.toThrow("预占");
    await api.cancelOrder(reserved);
    await api.cancelOrder(reserved);
    expect(availableStock(db(), "p01", "p01-s1")).toBe(2);
    await api.payOrder(legacy);
    expect(db().products[0]!.skus[0]!.stock).toBe(1);
    expect(
      own(reserved).events.filter((e) => e.action === "cancelled"),
    ).toHaveLength(1);
  });
  it("competing quotes cannot overreserve and timeout preserves ledger stock", async () => {
    change((d) => {
      d.products[0]!.skus[0]!.stock = 1;
    });
    const q1 = await api.quoteCheckout(input()),
      q2 = await api.quoteCheckout(input());
    const result = await Promise.allSettled([
      api.createOrder({ quoteId: q1.id, requestId: "one" }),
      api.createOrder({ quoteId: q2.id, requestId: "two" }),
    ]);
    expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const id = (
      result.find(
        (r) => r.status === "fulfilled",
      ) as PromiseFulfilledResult<string>
    ).value;
    change((d) => {
      d.orders.find((o) => o.id === id)!.expiresAt = new Date(0).toISOString();
    });
    expirePendingOrders(sql);
    expirePendingOrders(sql);
    expect(availableStock(db(), "p01", "p01-s1")).toBe(1);
    expect(db().ledger.filter((l) => l.reference === id)).toHaveLength(0);
    expect(
      sql
        .prepare("SELECT COUNT(*) AS count FROM job_queue WHERE id=?")
        .get(`expiry:${id}`),
    ).toEqual({ count: 1 });
  });
  it("chooses automatic full reduction on a tie, preserves coupon, and invalidates changed shipping quotes", async () => {
    change((d) => {
      const time = Date.now();
      d.promotions = [
        {
          id: "promotion",
          name: "满减",
          threshold: 1000,
          discount: 101,
          startsAt: new Date(time - 1000).toISOString(),
          endsAt: new Date(time + 86400000).toISOString(),
          active: true,
          version: 1,
        },
      ];
      d.coupons = [
        {
          id: "coupon",
          name: "优惠券",
          threshold: 1000,
          discount: 101,
          claimStartsAt: new Date(time - 1000).toISOString(),
          claimEndsAt: new Date(time + 86400000).toISOString(),
          validFrom: new Date(time - 1000).toISOString(),
          validUntil: new Date(time + 86400000).toISOString(),
          totalLimit: 10,
          active: true,
        },
      ];
      d.couponClaims = [
        {
          id: "claim",
          userId: "u1",
          couponId: "coupon",
          status: "available",
          claimedAt: new Date(time).toISOString(),
        },
      ];
      d.shippingRules = [
        {
          id: "ship",
          name: "运费",
          province: "*",
          enabled: true,
          fee: 800,
          freeAbove: 50000,
          version: 1,
        },
      ];
    });
    const quote = await api.quoteCheckout(input());
    expect(quote).toMatchObject({
      discount: 101,
      shippingFee: 800,
      total: 40599,
      promotion: { id: "promotion" },
    });
    expect(quote.coupon).toBeUndefined();
    change((d) => {
      d.shippingRules![0]!.fee = 900;
    });
    await expect(
      api.createOrder({ quoteId: quote.id, requestId: "old-quote" }),
    ).rejects.toThrow("重新确认");
    const id = await order();
    expect(own(id).promotion?.id).toBe("promotion");
    expect(db().couponClaims[0]!.status).toBe("available");
    change((d) => {
      d.shippingRules = [
        {
          id: "blocked",
          name: "暂停配送",
          province: "*",
          enabled: false,
          fee: 0,
          freeAbove: 0,
          version: 1,
        },
      ];
    });
    await expect(api.quoteCheckout(input())).rejects.toThrow("暂不配送");
  });
  it("refunds shipping only when all unshipped quantities are cumulatively returned", async () => {
    change((d) => {
      d.shippingRules = [
        {
          id: "ship",
          name: "运费",
          province: "*",
          enabled: true,
          fee: 801,
          freeAbove: 0,
          version: 1,
        },
      ];
    });
    const id = await order(3);
    await api.payOrder(id);
    await refund(id, 1);
    expect(own(id).refundedAmount).toBe(39900);
    expect(own(id).shippingRefunded).toBe(0);
    const sale = await refund(id, 2);
    expect(own(id).refundedAmount).toBe(own(id).total);
    expect(own(id).shippingRefunded).toBe(801);
    await api.processAfterSale(sale, "refund");
    expect(own(id).refundedAmount).toBe(own(id).total);
    expect(
      db()
        .ledger.filter((l) => l.reference === id && l.type === "refund")
        .reduce((n, l) => n + l.amount, 0),
    ).toBe(own(id).total);
  });
  it("earns points once on remaining goods and returns stay quarantined independently of refund", async () => {
    const id = await order(3);
    await api.payOrder(id);
    await api.shipOrder(id, "物流", "TRACK");
    await api.confirmOrder(id);
    await api.confirmOrder(id);
    expect(
      db()
        .pointsEntries!.filter((p) => p.orderId === id)
        .reduce((n, p) => n + p.delta, 0),
    ).toBe(1197);
    const stock = db().products[0]!.skus[0]!.stock;
    const sale = await refund(id, 1, true);
    await api.processAfterSale(sale, "refund");
    expect(db().products[0]!.skus[0]!.stock).toBe(stock);
    expect(
      db().returnInspections!.filter((i) => i.afterSaleId === sale),
    ).toEqual([
      expect.objectContaining({ quantity: 1, status: "pending", good: 0 }),
    ]);
    expect(
      db()
        .pointsEntries!.filter((p) => p.orderId === id)
        .reduce((n, p) => n + p.delta, 0),
    ).toBe(798);
    change((d) => {
      d.orders.find((o) => o.id === id)!.completedAt = new Date(
        Date.now() - 8 * 86400000,
      ).toISOString();
    });
    await expect(
      api.requestAfterSale(id, "退款", "已过期限", [
        { orderItemId: own(id).items[0]!.id, quantity: 1 },
      ]),
    ).rejects.toThrow("期限");
    change((d) => {
      delete d.orders.find((o) => o.id === id)!.afterSaleDays;
      delete d.orders.find((o) => o.id === id)!.pointsPolicy;
    });
    await api.requestAfterSale(id, "旧订单", "保留历史资格", [
      { orderItemId: own(id).items[0]!.id, quantity: 1 },
    ]);
  });
  it("rejects stale metadata versions and explicit target never flips twice", async () => {
    const product = db().products[0]!;
    await api.saveProduct({ ...product, version: 1, subtitle: "新的副标题" });
    await expect(
      api.saveProduct({ ...product, version: 1, subtitle: "过期草稿" }),
    ).rejects.toMatchObject({ status: 409 });
    expect(db().products[0]!.subtitle).toBe("新的副标题");
    await api.toggleProduct(product.id, false, 2);
    await expect(api.toggleProduct(product.id, true, 2)).rejects.toMatchObject({
      status: 409,
    });
    await api.toggleProduct(product.id, false, 3);
    expect(db().products[0]!.active).toBe(false);
  });
});
