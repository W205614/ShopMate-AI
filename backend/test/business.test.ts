import { beforeEach, describe, expect, it } from "vitest";
import { commerceApi } from "../src/commerce";
import { catalogApi } from "../src/catalog";
import { supportApi } from "../src/support";
import { context } from "../src/repository";
import { openDatabase, readDatabase, writeDatabase } from "../src/database";
import { createSeed } from "../../shared/domain/seed";
import type { Role, Session } from "../../shared/domain/types";
const sql = openDatabase(":memory:");
let sessions: { user: Session | null; admin: Session | null };
const services = { ...commerceApi, ...catalogApi, ...supportApi };
const api = {
  ...(Object.fromEntries(
    Object.entries(services).map(([key, fn]) => [
      key,
      (...args: unknown[]) =>
        context.run({ sql, ...sessions }, () =>
          (fn as (...args: unknown[]) => Promise<unknown>)(...args),
        ),
    ]),
  ) as typeof services),
  async login(role: Role, username: string, _password: string) {
    sessions[role] = {
      id: username === "lin" ? "u1" : username === "chen" ? "u2" : "admin",
      name: username,
      role,
    };
  },
  async logout(role: Role) {
    sessions[role] = null;
  },
};
const getDatabase = () => readDatabase(sql);

beforeEach(async () => {
  writeDatabase(sql, createSeed());
  sessions = { user: null, admin: null };
  await api.login("user", "lin", "demo123");
  await api.login("admin", "admin", "demo123");
});
async function newOrder(product = "p01", quantity = 1) {
  await api.addCart(product, `${product}-s1`, quantity);
  const quote = await api.quoteCheckout({
    addressId: "a1",
    source: {
      type: "cart",
      cartIds: getDatabase()
        .carts.filter((c) => c.userId === "u1" && c.selected)
        .map((c) => c.id),
    },
  });
  return api.createOrder({ quoteId: quote.id, requestId: crypto.randomUUID() });
}

describe("交易与库存", () => {
  it("设置允许空公告，过期编辑基线不能覆盖新设置", async () => {
    const baseline = getDatabase().settings;
    const next = { ...baseline, name: "更新后的商城", notice: "" };
    await api.saveSettings(next, baseline);
    expect(getDatabase().settings).toEqual(next);
    await expect(
      api.saveSettings({ ...baseline, name: "过期草稿" }, baseline),
    ).rejects.toMatchObject({ status: 409 });
    expect(getDatabase().settings).toEqual(next);
    await api.saveSettings({ ...next, slogan: "重新确认后保存" }, next);
    expect(getDatabase().settings.slogan).toBe("重新确认后保存");
  });
  it("所有 SKU 的变动累计等于库存，编辑商品不会凭空新增期初记录", async () => {
    const before = getDatabase();
    for (const p of before.products)
      for (const s of p.skus)
        expect(
          before.inventory
            .filter((m) => m.skuId === s.id)
            .reduce((n, m) => n + m.delta, 0),
        ).toBe(s.stock);
    await api.saveProduct({
      ...before.products[5]!,
      subtitle: "只修改商品副标题",
    });
    expect(getDatabase().inventory).toEqual(before.inventory);
  });
  it("整数金额、快照、付款幂等与取消状态", async () => {
    const before = getDatabase(),
      stock = before.products[0]!.skus[0]!.stock;
    const orderId = await newOrder("p01", 2);
    expect(getDatabase().orders[0]!.total).toBe(79800);
    expect(getDatabase().products[0]!.skus[0]!.stock).toBe(stock);
    await Promise.all([api.payOrder(orderId), api.payOrder(orderId)]);
    const db = getDatabase();
    expect(db.products[0]!.skus[0]!.stock).toBe(stock - 2);
    expect(db.ledger.filter((l) => l.reference === orderId)).toHaveLength(1);
    expect(db.orders[0]!.status).toBe("paid");
    await expect(api.cancelOrder(orderId)).rejects.toThrow("只有待付款");
  });
  it("订单快照不随后台改价改变，付款重新校验库存及上下架", async () => {
    const orderId = await newOrder();
    const product = getDatabase().products[0]!;
    await api.saveProduct({
      ...product,
      skus: product.skus.map((s) => ({ ...s, price: s.price + 10000 })),
    });
    expect(getDatabase().orders.find((o) => o.id === orderId)!.total).toBe(
      39900,
    );
    await api.toggleProduct("p01");
    await expect(api.payOrder(orderId)).rejects.toThrow("已下架或库存不足");
    expect(
      getDatabase().ledger.filter((l) => l.reference === orderId),
    ).toHaveLength(0);
  });
  it("并行付款不能超卖，失败不会出现部分扣库存", async () => {
    const stock = getDatabase().products.find((p) => p.id === "p03")!.skus[0]!
      .stock;
    const one = await newOrder("p03", stock),
      two = await newOrder("p03", stock);
    const results = await Promise.allSettled([
      api.payOrder(one),
      api.payOrder(two),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      getDatabase().products.find((p) => p.id === "p03")!.skus[0]!.stock,
    ).toBe(0);
    expect(getDatabase().orders.find((o) => o.id === two)!.status).toBe(
      "pending",
    );
  });
  it("退款仅回补一次，发货后必须先确认退货收货", async () => {
    const orderId = await newOrder();
    const before = getDatabase().products[0]!.skus[0]!.stock;
    await api.payOrder(orderId);
    await api.shipOrder(orderId, "演示物流", "DEMO-TEST");
    await api.requestAfterSale(
      orderId,
      "不再需要",
      "演示退款流程",
      getDatabase()
        .orders.find((o) => o.id === orderId)!
        .items.map((i) => ({ orderItemId: i.id, quantity: i.quantity })),
    );
    const sale = getDatabase().afterSales[0]!;
    await api.processAfterSale(sale.id, "approve");
    await expect(api.processAfterSale(sale.id, "refund")).rejects.toThrow(
      "退货收货",
    );
    await expect(api.processAfterSale(sale.id, "receive")).rejects.toThrow(
      "退货单号",
    );
    await api.submitReturn(sale.id, "退货物流", "RETURN-DEMO");
    await api.processAfterSale(sale.id, "receive");
    await Promise.all([
      api.processAfterSale(sale.id, "refund"),
      api.processAfterSale(sale.id, "refund"),
    ]);
    const db = getDatabase();
    expect(db.products[0]!.skus[0]!.stock).toBe(before);
    expect(
      db.ledger.filter((l) => l.reference === orderId && l.type === "refund"),
    ).toHaveLength(1);
    expect(db.orders.find((o) => o.id === orderId)!.status).toBe("refunded");
  });
  it("未发货退款无需退货，售后期间禁止发货", async () => {
    const orderId = await newOrder();
    await api.payOrder(orderId);
    await api.requestAfterSale(
      orderId,
      "取消购买",
      "尚未发货",
      getDatabase()
        .orders.find((o) => o.id === orderId)!
        .items.map((i) => ({ orderItemId: i.id, quantity: i.quantity })),
    );
    await expect(api.shipOrder(orderId, "演示", "123")).rejects.toThrow("售后");
    const sale = getDatabase().afterSales[0]!;
    expect(sale.requiresReturn).toBe(false);
    await api.processAfterSale(sale.id, "approve");
    await api.processAfterSale(sale.id, "refund");
    expect(getDatabase().orders[0]!.status).toBe("refunded");
  });
  it("不接受负数、小数与超库存数量；缺货不能加购", async () => {
    for (const n of [-1, 0, 1.2, 99999])
      await expect(api.addCart("p01", "p01-s1", n)).rejects.toThrow();
    await expect(api.addCart("p22", "p22-s1", 1)).rejects.toThrow("库存不足");
    await expect(api.addCart("p24", "p24-s1", 1)).rejects.toThrow("下架");
  });
});
describe("身份、管理与客服", () => {
  it("用户不能操作另一个用户的订单、地址、会话", async () => {
    const orderId = await newOrder(),
      conversationId = await api.createConversation();
    await api.login("user", "chen", "demo123");
    await expect(api.payOrder(orderId)).rejects.toThrow("不属于当前用户");
    await expect(
      api.quoteCheckout({
        addressId: "a1",
        source: {
          type: "buyNow",
          productId: "p01",
          skuId: "p01-s1",
          quantity: 1,
        },
      }),
    ).rejects.toThrow("自己的有效");
    await expect(api.sendMessage(conversationId, "你好")).rejects.toThrow(
      "会话不存在",
    );
    await expect(api.createConversation({ orderId })).rejects.toThrow(
      "不属于当前用户",
    );
  });
  it("管理操作要求管理身份，分类删除保护商品引用", async () => {
    await expect(api.deleteCategory("c1")).rejects.toThrow("关联商品");
    await api.logout("admin");
    await expect(api.toggleProduct("p01")).rejects.toThrow("管理账号");
    await expect(
      api.adjustStock("p01", "p01-s1", 2, 1000, "补货"),
    ).rejects.toThrow("管理账号");
  });
  it("补货记支出与变动，已有库存不能绕过审计修改", async () => {
    const p = getDatabase().products[0]!,
      stock = p.skus[0]!.stock;
    await api.adjustStock("p01", "p01-s1", 5, 10000, "测试采购");
    expect(getDatabase().products[0]!.skus[0]!.stock).toBe(stock + 5);
    expect(getDatabase().ledger[0]).toMatchObject({
      type: "purchase",
      amount: 10000,
    });
    const current = getDatabase().products[0]!;
    await expect(
      api.saveProduct({
        ...current,
        skus: current.skus.map((s) => ({ ...s, stock: 500 })),
      }),
    ).rejects.toThrow("库存管理");
  });
  it("FAQ 启停影响回复，转人工后不自动回复，人工回复可见", async () => {
    await api.saveFaq({
      question: "暗号",
      keywords: ["测试暗号"],
      answer: "规则命中",
      active: true,
    });
    const conversationId = await api.createConversation({ productId: "p01" });
    await api.sendMessage(conversationId, "测试暗号");
    expect(getDatabase().conversations[0]!.messages.at(-1)!.text).toBe(
      "规则命中",
    );
    const faq = getDatabase().faqs.at(-1)!;
    await api.saveFaq({ ...faq, active: false });
    await api.sendMessage(conversationId, "测试暗号");
    expect(getDatabase().conversations[0]!.messages.at(-1)!.text).not.toBe(
      "规则命中",
    );
    await api.transferConversation(conversationId);
    const count = getDatabase().conversations[0]!.messages.length;
    await api.sendMessage(conversationId, "等待人工");
    expect(getDatabase().conversations[0]!.messages).toHaveLength(count + 1);
    await api.replyConversation(conversationId, "人工已接待");
    expect(getDatabase().conversations[0]!.messages.at(-1)).toMatchObject({
      role: "agent",
      text: "人工已接待",
    });
    await api.closeConversation(conversationId);
    await expect(api.sendMessage(conversationId, "继续")).rejects.toThrow(
      "已关闭",
    );
  });
});
