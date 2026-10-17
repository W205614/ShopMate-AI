import { beforeEach, describe, expect, it } from "vitest";
import { commerceApi, expirePendingOrders } from "../src/commerce";
import { context } from "../src/repository";
import { openDatabase, readDatabase, writeDatabase } from "../src/database";
import { createSeed } from "../../shared/domain/seed";
import { allocateDiscount } from "../src/commerce-rules";
import type {
  CheckoutInput,
  Database,
  OrderItem,
  Session,
} from "../../shared/domain/types";

const sql = openDatabase(":memory:");
let uid: string;
const api = Object.fromEntries(
  Object.entries(commerceApi).map(([key, fn]) => [
    key,
    (...args: unknown[]) =>
      context.run(
        {
          sql,
          user: { id: uid, name: uid, role: "user" },
          admin: { id: "admin", name: "admin", role: "admin" } as Session,
        },
        () => (fn as (...args: unknown[]) => Promise<unknown>)(...args),
      ),
  ]),
) as typeof commerceApi;
const db = () => readDatabase(sql);
function change(fn: (value: Database) => void) {
  const value = db();
  fn(value);
  writeDatabase(sql, value);
}
const buy = (quantity = 1, couponClaimId?: string): CheckoutInput => ({
  addressId: "a1",
  source: { type: "buyNow", productId: "p01", skuId: "p01-s1", quantity },
  ...(couponClaimId ? { couponClaimId } : {}),
});
async function order(input = buy()) {
  const quote = await api.quoteCheckout(input);
  return api.createOrder({ quoteId: quote.id, requestId: crypto.randomUUID() });
}
function coupon(discount = 101) {
  change((v) => {
    const at = Date.now();
    v.coupons.push({
      id: "coupon",
      name: "满减",
      threshold: 1000,
      discount,
      claimStartsAt: new Date(at - 86400000).toISOString(),
      claimEndsAt: new Date(at + 86400000).toISOString(),
      validFrom: new Date(at - 86400000).toISOString(),
      validUntil: new Date(at + 86400000).toISOString(),
      totalLimit: 10,
      active: true,
    });
    v.couponClaims.push({
      id: "claim",
      userId: "u1",
      couponId: "coupon",
      status: "available",
      claimedAt: new Date(at).toISOString(),
    });
  });
}
beforeEach(() => {
  writeDatabase(sql, createSeed());
  uid = "u1";
});

describe("报价与订单一致性", () => {
  it("结束恢复会关闭未消费报价，迟到请求不能复活；已有订单优先找回", async () => {
    const quote = await api.quoteCheckout(buy());
    const input = { quoteId: quote.id, requestId: crypto.randomUUID() };
    expect(await api.retireCheckout(input)).toBeNull();
    await expect(api.createOrder(input)).rejects.toThrow("过期");
    expect(db().orders.some((o) => o.quoteId === quote.id)).toBe(false);
    const next = await api.quoteCheckout(buy());
    const created = { quoteId: next.id, requestId: crypto.randomUUID() };
    const orderId = await api.createOrder(created);
    const before = db();
    expect(await api.retireCheckout(created)).toBe(orderId);
    expect(db().orders).toEqual(before.orders);
    expect(db().inventory).toEqual(before.inventory);
    expect(db().ledger).toEqual(before.ledger);
    uid = "u2";
    expect(await api.retireCheckout(created)).toBeNull();
    expect(db().checkoutQuotes.find((q) => q.id === next.id)?.orderId).toBe(
      orderId,
    );
  });
  it("相同商品的不同订单行 ID 全局不同且重新读取保持稳定", async () => {
    const first = await order(),
      second = await order();
    const firstItem = db().orders.find((o) => o.id === first)!.items[0]!.id;
    const secondItem = db().orders.find((o) => o.id === second)!.items[0]!.id;
    expect(firstItem).not.toBe(secondItem);
    expect(firstItem.startsWith(first)).toBe(true);
    expect(secondItem.startsWith(second)).toBe(true);
    expect(db().orders.find((o) => o.id === first)!.items[0]!.id).toBe(
      firstItem,
    );
  });
  it("优惠券按实际时刻判断带 +08:00 的使用期，已过期券不能因偏移字符串被使用", async () => {
    coupon();
    const localOffset = (epoch: number) =>
      new Date(epoch + 8 * 3600000).toISOString().replace("Z", "+08:00");
    change((v) => {
      v.coupons[0]!.validFrom = localOffset(Date.now() - 3600000);
      v.coupons[0]!.validUntil = localOffset(Date.now() + 3600000);
    });
    expect((await api.quoteCheckout(buy(1, "claim"))).discount).toBe(101);
    // A UTC start isolates the expired offset end; lexicographic comparison incorrectly accepts it.
    change((v) => {
      v.coupons[0]!.validFrom = new Date(Date.now() - 3600000).toISOString();
      v.coupons[0]!.validUntil = localOffset(Date.now() - 60000);
    });
    await expect(api.quoteCheckout(buy(1, "claim"))).rejects.toThrow(
      "优惠券不可用",
    );
    expect(db().couponClaims[0]!.status).toBe("available");
  });
  it("立即购买不修改购物车，购物车报价只消费显式提交的条目", async () => {
    await api.addCart("p01", "p01-s1", 1);
    await api.addCart("p02", "p02-s1", 1);
    const carts = db().carts;
    await order();
    expect(db().carts).toEqual(carts);
    const quote = await api.quoteCheckout({
      addressId: "a1",
      source: { type: "cart", cartIds: [carts[0]!.id] },
    });
    await api.createOrder({ quoteId: quote.id, requestId: "cart" });
    expect(db().carts.map((c) => c.id)).toEqual([carts[1]!.id]);
  });
  it.each(["price", "address", "cart", "coupon"])(
    "%s 变化后报价拒绝创建且不消费购物车",
    async (kind) => {
      coupon();
      await api.addCart("p01", "p01-s1", 1);
      const quote = await api.quoteCheckout({
        addressId: "a1",
        couponClaimId: "claim",
        source: { type: "cart", cartIds: [db().carts[0]!.id] },
      });
      change((v) => {
        if (kind === "price") v.products[0]!.skus[0]!.price++;
        if (kind === "address") v.addresses[0]!.detail += "新";
        if (kind === "cart") v.carts[0]!.quantity++;
        if (kind === "coupon") v.coupons[0]!.name += "新";
      });
      const count = db().orders.length;
      await expect(
        api.createOrder({ quoteId: quote.id, requestId: "stale" }),
      ).rejects.toThrow("重新确认");
      expect(db().orders).toHaveLength(count);
      expect(db().carts).toHaveLength(1);
      expect(db().couponClaims[0]!.status).toBe("available");
    },
  );
  it("过期报价、跨用户报价和跨用户条目拒绝使用", async () => {
    const quote = await api.quoteCheckout(buy());
    uid = "u2";
    await expect(
      api.createOrder({ quoteId: quote.id, requestId: "foreign" }),
    ).rejects.toThrow("报价不存在");
    uid = "u1";
    change((v) => {
      v.checkoutQuotes[0]!.expiresAt = new Date(0).toISOString();
    });
    await expect(
      api.createOrder({ quoteId: quote.id, requestId: "expired" }),
    ).rejects.toThrow("过期");
  });
  it("同键或同报价重复创建只产生一笔订单，替代键也绑定原报价", async () => {
    const quote = await api.quoteCheckout(buy()),
      before = db().orders.length;
    const results = await Promise.all([
      api.createOrder({ quoteId: quote.id, requestId: "first" }),
      api.createOrder({ quoteId: quote.id, requestId: "first" }),
    ]);
    expect(results[0]).toBe(results[1]);
    expect(
      await api.createOrder({ quoteId: quote.id, requestId: "alternate" }),
    ).toBe(results[0]);
    const next = await api.quoteCheckout(buy());
    await expect(
      api.createOrder({ quoteId: next.id, requestId: "alternate" }),
    ).rejects.toThrow("不同报价");
    expect(db().orders).toHaveLength(before + 1);
  });
  it("优惠券下单占用、取消释放、支付核销且付款保留订单优惠快照", async () => {
    coupon();
    const first = await order(buy(1, "claim"));
    expect(db().couponClaims[0]!.status).toBe("locked");
    await expect(api.quoteCheckout(buy(1, "claim"))).rejects.toThrow(
      "优惠券不可用",
    );
    await api.cancelOrder(first);
    expect(db().couponClaims[0]!.status).toBe("available");
    const second = await order(buy(1, "claim"));
    change((v) => {
      v.coupons[0]!.active = false;
      v.coupons[0]!.validUntil = new Date(0).toISOString();
    });
    await api.payOrder(second);
    expect(db().couponClaims[0]!.status).toBe("used");
    expect(db().orders.find((o) => o.id === second)!.total).toBe(39799);
  });
  it("超时关闭只发生一次、释放优惠券，超时付款不扣库不记账", async () => {
    coupon();
    const value = await order(buy(1, "claim"));
    const stock = db().products[0]!.skus[0]!.stock;
    change((v) => {
      v.orders.find((o) => o.id === value)!.expiresAt = new Date(
        0,
      ).toISOString();
    });
    await expect(api.payOrder(value)).rejects.toThrow("付款超时");
    const expired = db().orders.find((o) => o.id === value)!;
    expect(expired.status).toBe("cancelled");
    expect(expired.events.filter((e) => e.action === "cancelled")).toHaveLength(
      1,
    );
    expirePendingOrders(sql);
    expect(db().orders.find((o) => o.id === value)!.events).toEqual(
      expired.events,
    );
    expect(db().couponClaims[0]!.status).toBe("available");
    expect(db().products[0]!.skus[0]!.stock).toBe(stock);
    expect(db().ledger.filter((l) => l.reference === value)).toHaveLength(0);
  });
  it("付款先完成后超时处理不会取消或回补库存", async () => {
    const value = await order();
    await api.payOrder(value);
    change((v) => {
      v.orders.find((o) => o.id === value)!.expiresAt = new Date(
        0,
      ).toISOString();
    });
    expirePendingOrders(sql);
    expect(db().orders.find((o) => o.id === value)!.status).toBe("paid");
  });
});

describe("批量操作、地址与部分售后", () => {
  it("批量勾选跳过缺货而保留条目，清理只移除下架或失效规格，跨用户批量回滚", async () => {
    await api.addCart("p01", "p01-s1", 1);
    await api.addCart("p02", "p02-s1", 1);
    const ids = db().carts.map((c) => c.id);
    change((v) => {
      v.products[0]!.skus[0]!.stock = 0;
    });
    await api.batchCart({ ids, action: "select", selected: true });
    expect(db().carts.map((c) => c.selected)).toEqual([false, true]);
    await api.clearInvalidCart();
    expect(db().carts).toHaveLength(2);
    uid = "u2";
    await api.addCart("p03", "p03-s1", 1);
    const foreign = db().carts.at(-1)!.id;
    uid = "u1";
    await expect(
      api.batchCart({ ids: [ids[1]!, foreign], action: "remove" }),
    ).rejects.toThrow("不属于当前用户");
    expect(db().carts).toHaveLength(3);
    change((v) => {
      v.products[1]!.active = false;
    });
    await api.clearInvalidCart();
    expect(db().carts.map((c) => c.id)).toEqual([ids[0], foreign]);
  });
  it("默认地址不能被编辑成零默认，删除默认后自动选择；下架收藏仍能移除", async () => {
    await api.saveAddress({ ...db().addresses[0]!, isDefault: false });
    expect(
      db().addresses.filter((a) => a.userId === "u1" && a.isDefault),
    ).toHaveLength(1);
    await api.saveAddress({
      name: "新增",
      phone: "13800000009",
      region: "上海",
      detail: "路1号",
      isDefault: false,
    });
    await api.deleteAddress("a1");
    expect(
      db().addresses.filter((a) => a.userId === "u1" && a.isDefault),
    ).toHaveLength(1);
    change((v) => {
      v.products[0]!.active = false;
    });
    await api.favorite("p01");
    expect(db().favorites.u1).not.toContain("p01");
    await expect(api.favorite("p01")).rejects.toThrow("下架");
  });
  it("最大余数分摊支持大整数乘积并严格守恒", () => {
    const items = [1, 2, 3].map(
      (value) => ({ price: value, quantity: 1 }) as OrderItem,
    );
    allocateDiscount(items, 2);
    expect(items.map((i) => i.discount)).toEqual([0, 1, 1]);
    const large = [
      { price: 1000000000, quantity: 1000000 },
      { price: 2000000000, quantity: 1000000 },
    ] as OrderItem[];
    allocateDiscount(large, 1000000001);
    expect(large.reduce((n, i) => n + i.discount, 0)).toBe(1000000001);
  });
  it("三次部分退款吸收尾差、数量金额库存守恒，重复退款无重复回补，退款不退券", async () => {
    coupon(100);
    const value = await order(buy(3, "claim"));
    await api.payOrder(value);
    const original = db().orders.find((o) => o.id === value)!,
      stock = db().products[0]!.skus[0]!.stock,
      line = original.items[0]!;
    const amounts: number[] = [];
    for (let index = 0; index < 3; index++) {
      await api.requestAfterSale(value, "部分退款", "退其中一件商品", [
        { orderItemId: line.id, quantity: 1 },
      ]);
      const sale = db().afterSales[0]!;
      amounts.push(sale.refundAmount);
      await api.processAfterSale(sale.id, "approve");
      await Promise.all([
        api.processAfterSale(sale.id, "refund"),
        api.processAfterSale(sale.id, "refund"),
      ]);
      expect(db().orders.find((o) => o.id === value)!.status).toBe(
        index === 2 ? "refunded" : "paid",
      );
      if (index < 2)
        await expect(
          api.requestAfterSale(value, "超额", "不能超过剩余数量", [
            { orderItemId: line.id, quantity: 3 },
          ]),
        ).rejects.toThrow("剩余可退");
    }
    expect(amounts).toEqual([39866, 39867, 39867]);
    expect(amounts.reduce((n, a) => n + a, 0)).toBe(original.total);
    expect(db().products[0]!.skus[0]!.stock).toBe(stock + 3);
    expect(db().orders.find((o) => o.id === value)!.refundedAmount).toBe(
      original.total,
    );
    expect(db().couponClaims[0]!.status).toBe("used");
    expect(
      db().ledger.filter((l) => l.reference === value && l.type === "refund"),
    ).toHaveLength(3);
  });
  it("撤销和拒绝释放申请数量，退货单号提交后不能撤销，部分退款后可继续履约", async () => {
    const value = await order(buy(2));
    await api.payOrder(value);
    const line = db().orders.find((o) => o.id === value)!.items[0]!;
    const request = () =>
      api.requestAfterSale(value, "退货", "其中一件不合适", [
        { orderItemId: line.id, quantity: 1 },
      ]);
    await request();
    await api.cancelAfterSale(db().afterSales[0]!.id);
    await request();
    await api.processAfterSale(
      db().afterSales[0]!.id,
      "reject",
      "模拟拒绝理由",
    );
    await request();
    const first = db().afterSales[0]!;
    await api.processAfterSale(first.id, "approve");
    await api.processAfterSale(first.id, "refund");
    await api.shipOrder(value, "物流", "TRACK");
    await request();
    const sale = db().afterSales[0]!;
    await expect(api.confirmOrder(value)).rejects.toThrow("售后");
    uid = "u2";
    await expect(api.cancelAfterSale(sale.id)).rejects.toThrow(
      "不属于当前用户",
    );
    uid = "u1";
    await api.processAfterSale(sale.id, "approve");
    await expect(api.processAfterSale(sale.id, "receive")).rejects.toThrow(
      "退货单号",
    );
    await api.submitReturn(sale.id, "退货物流", "RETURN");
    await expect(api.cancelAfterSale(sale.id)).rejects.toThrow("不可撤销");
    await api.processAfterSale(sale.id, "receive");
    await api.processAfterSale(sale.id, "refund");
    expect(db().orders.find((o) => o.id === value)!.status).toBe("refunded");
  });
  it("再次购买使用当前库存与规格，有失败条目时报告且不自动下单", async () => {
    const value = await order();
    change((v) => {
      v.products[0]!.active = false;
    });
    const count = db().orders.length;
    expect(await api.reorder(value)).toMatchObject({
      added: 0,
      skipped: [expect.stringContaining("已下架")],
    });
    change((v) => {
      v.products[0]!.active = true;
      v.products[0]!.skus[0]!.price++;
    });
    expect(await api.reorder(value)).toEqual({ added: 1, skipped: [] });
    expect(db().carts[0]!.quantity).toBe(1);
    expect(db().orders).toHaveLength(count);
  });
});
