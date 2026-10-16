import { beforeEach, describe, expect, it } from "vitest";
import { api, getDatabase, STORAGE_KEY, subscribeDatabase } from "./api";

beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  await api.login("user", "lin", "demo123");
  await api.login("admin", "admin", "demo123");
});
async function newOrder(product = "p01", quantity = 1) {
  await api.addCart(product, `${product}-s1`, quantity);
  return api.createOrder("a1");
}

describe("交易与库存", () => {
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
    await api.requestAfterSale(orderId, "不再需要", "演示退款流程");
    const sale = getDatabase().afterSales[0]!;
    await api.processAfterSale(sale.id, "approve");
    await expect(api.processAfterSale(sale.id, "refund")).rejects.toThrow(
      "退货收货",
    );
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
    await api.requestAfterSale(orderId, "取消购买", "尚未发货");
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
    await expect(api.createOrder("a1")).rejects.toThrow("自己的有效");
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
  it("无效库存变动不改变账目；恢复初始数据可处理损坏存储", async () => {
    const before = getDatabase();
    await expect(
      api.adjustStock("p01", "p01-s1", -99999, 0, "错误调整"),
    ).rejects.toThrow();
    expect(getDatabase()).toEqual(before);
    localStorage.setItem(STORAGE_KEY, "{bad");
    await expect(api.favorite("p01")).rejects.toThrow("数据损坏");
    await api.resetDemo();
    expect(getDatabase().products).toHaveLength(24);
  });
  it("合法 JSON 的嵌套损坏也可恢复且不覆盖原数据", async () => {
    const corrupt = { ...getDatabase(), products: [null] };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(corrupt));
    expect(getDatabase().products).toHaveLength(24);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).products).toEqual([
      null,
    ]);
    await expect(api.favorite("p01")).rejects.toThrow("数据损坏");
    await api.resetDemo();
    expect(getDatabase().products[0]!.name).toBe("静听 无线头戴耳机");
  });
  it("提交后通知订阅者，其他标签页 storage 事件同步", async () => {
    let revision = 0;
    const stop = subscribeDatabase((db) => {
      revision = db.revision;
    });
    await api.favorite("p01");
    expect(revision).toBe(1);
    const db = getDatabase();
    db.revision = 9;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
    window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }));
    expect(revision).toBe(9);
    stop();
  });
});
