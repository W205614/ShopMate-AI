import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  openDatabase,
  readDatabase,
  writeDatabase,
  transaction,
} from "../src/database";
import { context } from "../src/repository";
import { commerceApi, expirePendingOrders } from "../src/commerce";
import { availableStock } from "../src/commerce-rules";
import { ensureAccountSchema, readMerchant } from "../src/production/accounts";
import { ensureExternalSchema } from "../src/production/external";
import { ensureRuntimeSchema } from "../src/runtime";
import {
  PaymentService,
  assertPaymentsClosable,
} from "../src/production/payments";
import {
  GatewayError,
  type PaymentGateway,
  type PaymentResult,
  type RefundResult,
  type BillEntry,
} from "../src/production/payment-providers";
import type { Payment, Refund } from "../../shared/domain/production";
import type { Database, Session } from "../../shared/domain/types";
import { createSeed } from "../../shared/domain/seed";

class Gateway implements PaymentGateway {
  provider = "wechatpay" as const;
  merchantId = "fixture-merchant";
  results = new Map<string, PaymentResult>();
  refundResults = new Map<string, RefundResult>();
  created: string[] = [];
  refunded: string[] = [];
  failCreate = false;
  failClose = false;
  failRefund = false;
  billRows: BillEntry[] = [];
  async create(payment: Payment) {
    this.created.push(payment.id);
    if (this.failCreate) throw new GatewayError("NETWORK_TIMEOUT", true);
    this.results.set(payment.id, {
      merchantOrderNo: payment.id,
      merchantId: this.merchantId,
      amount: payment.amount,
      currency: "CNY",
      status: "pending",
    });
    return { kind: "qr" as const, value: "weixin://wxpay/fixture" };
  }
  async query(payment: Payment) {
    return this.results.get(payment.id) ?? null;
  }
  async close(payment: Payment) {
    if (this.failClose) throw new GatewayError("NETWORK_TIMEOUT", true);
    this.results.set(payment.id, {
      ...this.results.get(payment.id)!,
      status: "closed",
    });
  }
  async refund(refund: Refund, payment: Payment) {
    this.refunded.push(refund.id);
    if (this.failRefund) throw new GatewayError("NETWORK_TIMEOUT", true);
    const result: RefundResult = {
      merchantRefundNo: refund.id,
      merchantOrderNo: payment.id,
      amount: refund.amount,
      status: "processing",
      providerRefundId: `provider-${refund.id}`,
    };
    this.refundResults.set(refund.id, result);
    return result;
  }
  async queryRefund(refund: Refund) {
    return this.refundResults.get(refund.id) ?? null;
  }
  webhook(raw: Buffer) {
    return JSON.parse(raw.toString());
  }
  async bill() {
    return this.billRows;
  }
}
let sql: DatabaseSync, gateway: Gateway, service: PaymentService;
const user: Session = { id: "u1", name: "顾客", role: "user" };
const admin: Session = {
  id: "admin",
  name: "店主",
  role: "admin",
  staffRole: "owner",
};
const invoke = <T>(fn: () => T) => context.run({ sql, user, admin }, fn);
const db = () => readDatabase(sql);
function change(fn: (database: Database) => void) {
  const value = db();
  fn(value);
  writeDatabase(sql, value);
}
async function newOrder(quantity = 1) {
  const quote = await invoke(() =>
    commerceApi.quoteCheckout({
      addressId: "a1",
      source: { type: "buyNow", productId: "p01", skuId: "p01-s1", quantity },
    }),
  );
  const id = await invoke(() =>
    commerceApi.createOrder({ quoteId: quote.id, requestId: randomUUID() }),
  );
  change((database) => {
    database.orders.find((order) => order.id === id)!.transactionMode =
      "production";
  });
  return id;
}
const payment = (id: string) =>
  JSON.parse(
    String(
      sql.prepare("SELECT data FROM production_payments WHERE id=?").get(id)!
        .data,
    ),
  ) as Payment;
const refund = (id: string) =>
  JSON.parse(
    String(
      sql.prepare("SELECT data FROM production_refunds WHERE id=?").get(id)!
        .data,
    ),
  ) as Refund;
async function paidOrder(quantity = 1) {
  const orderId = await newOrder(quantity);
  const p = service.create(
    user.id,
    orderId,
    "wechat_native",
    randomUUID(),
    "127.0.0.1",
  );
  await service.refresh(p.id);
  const result = {
    ...gateway.results.get(p.id)!,
    status: "succeeded" as const,
    succeededAt: new Date().toISOString(),
    providerTransactionId: `wx-${p.id}`,
  };
  gateway.results.set(p.id, result);
  service.receive("wechatpay", { id: `paid-${p.id}`, kind: "payment", result });
  service.processWebhooks();
  return { orderId, p };
}
async function approvedSale(orderId: string, quantity: number) {
  const order = db().orders.find((value) => value.id === orderId)!;
  await invoke(() =>
    commerceApi.requestAfterSale(orderId, "需要退款", "测试退款", [
      { orderItemId: order.items[0]!.id, quantity },
    ]),
  );
  const sale = db().afterSales[0]!;
  await invoke(() => commerceApi.processAfterSale(sale.id, "approve"));
  return sale.id;
}
beforeEach(() => {
  vi.stubEnv("SHOP_MODE", "demo");
  sql = openDatabase(":memory:");
  writeDatabase(sql, createSeed());
  ensureRuntimeSchema(sql);
  ensureAccountSchema(sql);
  ensureExternalSchema(sql);
  sql
    .prepare(
      "INSERT INTO accounts(id,username,name,role,password_hash,created_at) VALUES('u1','fixture','顾客','user','synthetic',1)",
    )
    .run();
  sql
    .prepare(
      "INSERT INTO verified_contacts VALUES('u1','email','fixture@example.test',1)",
    )
    .run();
  const merchant = readMerchant(sql);
  merchant.privacy = { version: "p1", title: "隐私", text: "合成测试政策" };
  merchant.terms = { version: "t1", title: "协议", text: "合成测试协议" };
  sql
    .prepare("UPDATE merchant_profile SET data=? WHERE id=1")
    .run(JSON.stringify(merchant));
  sql
    .prepare(
      "INSERT INTO policy_consents VALUES('u1','privacy','p1',1),('u1','terms','t1',1)",
    )
    .run();
  gateway = new Gateway();
  service = new PaymentService(sql, {
    mode: "production",
    channels: ["wechat_native", "wechat_h5"],
    gateways: { wechatpay: gateway },
  });
});
afterEach(() => {
  sql.close();
  vi.unstubAllEnvs();
});

describe("production channel lifecycle", () => {
  it("reuses one payment and rejects cross-channel/cross-owner and legacy payments", async () => {
    const id = await newOrder(),
      request = randomUUID();
    const p = service.create(
      user.id,
      id,
      "wechat_native",
      request,
      "127.0.0.1",
    );
    expect(
      service.create(user.id, id, "wechat_native", request, "127.0.0.1").id,
    ).toBe(p.id);
    expect(() =>
      service.create(user.id, id, "wechat_h5", randomUUID(), "127.0.0.1"),
    ).toThrow("关闭现有支付单");
    expect(() =>
      service.create("other", id, "wechat_native", randomUUID(), "127.0.0.1"),
    ).toThrow();
    expect(() =>
      service.create(user.id, id, "wechat_h5", request, "127.0.0.1"),
    ).toThrow("请求标识");
    await expect(invoke(() => commerceApi.payOrder(id))).rejects.toThrow(
      "真实订单不能模拟付款",
    );
  });
  it("persists unknown create results and retries with the original merchant order number", async () => {
    const id = await newOrder(),
      p = service.create(
        user.id,
        id,
        "wechat_native",
        randomUUID(),
        "127.0.0.1",
      );
    gateway.failCreate = true;
    await service.refresh(p.id);
    expect(payment(p.id).status).toBe("unknown");
    expect(db().orders.find((order) => order.id === id)!.paymentHold).toBe(
      true,
    );
    gateway.failCreate = false;
    await service.refresh(p.id);
    expect(gateway.created).toEqual([p.id, p.id]);
    expect(payment(p.id).status).toBe("pending");
  });
  it("does not release expired reservations when closing the provider is uncertain", async () => {
    const id = await newOrder(),
      p = service.create(
        user.id,
        id,
        "wechat_native",
        randomUUID(),
        "127.0.0.1",
      );
    await service.refresh(p.id);
    gateway.failClose = true;
    const before = availableStock(db(), "p01", "p01-s1");
    change((database) => {
      database.orders.find((order) => order.id === id)!.expiresAt =
        "2020-01-01T00:00:00.000Z";
    });
    expirePendingOrders(sql);
    await service.runDue();
    expect(db().orders.find((order) => order.id === id)!.status).toBe(
      "pending",
    );
    expect(availableStock(db(), "p01", "p01-s1")).toBe(before);
    expect(payment(p.id).status).toBe("unknown");
    gateway.failClose = false;
    await service.refresh(p.id);
    expect(db().orders.find((order) => order.id === id)!.status).toBe(
      "cancelled",
    );
    expect(availableStock(db(), "p01", "p01-s1")).toBe(before + 1);
  });
  it("settles authoritative payment received during cancellation exactly once", async () => {
    const id = await newOrder(),
      initial = db().products[0]!.skus[0]!.stock;
    const p = service.create(
      user.id,
      id,
      "wechat_native",
      randomUUID(),
      "127.0.0.1",
    );
    await service.refresh(p.id);
    await invoke(() => commerceApi.cancelOrder(id));
    expect(db().orders.find((order) => order.id === id)!.cancelRequested).toBe(
      true,
    );
    const event = {
      id: "same-event",
      kind: "payment" as const,
      result: {
        ...gateway.results.get(p.id)!,
        status: "succeeded" as const,
        succeededAt: new Date().toISOString(),
        providerTransactionId: "wx-paid",
      },
    };
    service.receive("wechatpay", event);
    service.receive("wechatpay", event);
    service.processWebhooks();
    service.receive("wechatpay", { ...event, id: "duplicate-with-new-event" });
    service.processWebhooks();
    expect(db().orders.find((order) => order.id === id)!.status).toBe("paid");
    expect(db().products[0]!.skus[0]!.stock).toBe(initial - 1);
    expect(
      db().ledger.filter(
        (entry) => entry.type === "payment" && entry.reference === id,
      ),
    ).toHaveLength(1);
    transaction(sql, () =>
      service.applyPayment(p.id, { ...event.result, status: "closed" }),
    );
    expect(payment(p.id).status).toBe("succeeded");
  });
  it("rejects mismatched money and conflicting duplicate callback IDs without changing inventory", async () => {
    const id = await newOrder(),
      p = service.create(
        user.id,
        id,
        "wechat_native",
        randomUUID(),
        "127.0.0.1",
      );
    await service.refresh(p.id);
    const result = {
      ...gateway.results.get(p.id)!,
      amount: p.amount + 1,
      status: "succeeded" as const,
      succeededAt: new Date().toISOString(),
      providerTransactionId: "bad-money",
    };
    service.receive("wechatpay", {
      id: "wrong-money",
      kind: "payment",
      result,
    });
    service.processWebhooks();
    expect(db().orders.find((order) => order.id === id)!.status).toBe(
      "pending",
    );
    expect(
      sql
        .prepare(
          "SELECT status FROM production_webhooks WHERE event_id='wrong-money'",
        )
        .get()!.status,
    ).toBe("failed");
    expect(() =>
      service.receive("wechatpay", {
        id: "wrong-money",
        kind: "payment",
        result: { ...result, amount: p.amount },
      }),
    ).toThrow("WEBHOOK_ID_CONFLICT");
  });
  it("keeps refunds processing until success and applies partial refunds exactly once", async () => {
    const { orderId, p } = await paidOrder(3),
      saleId = await approvedSale(orderId, 1);
    const r = service.createRefund("admin", saleId, "refund-one");
    await service.refreshRefund(r.id);
    expect(refund(r.id).status).toBe("processing");
    expect(
      db().afterSales.find((sale) => sale.id === saleId)!.refundPending,
    ).toBe(true);
    expect(
      db().orders.find((order) => order.id === orderId)!.refundedAmount,
    ).toBe(0);
    await expect(
      invoke(() => commerceApi.cancelAfterSale(saleId)),
    ).rejects.toThrow();
    const result = {
      ...gateway.refundResults.get(r.id)!,
      status: "succeeded" as const,
      succeededAt: new Date().toISOString(),
    };
    service.receive("wechatpay", { id: "refund-paid", kind: "refund", result });
    service.processWebhooks();
    service.receive("wechatpay", {
      id: "refund-paid-again",
      kind: "refund",
      result,
    });
    service.processWebhooks();
    expect(
      db().orders.find((order) => order.id === orderId)!.refundedAmount,
    ).toBe(r.amount);
    expect(
      db().ledger.filter(
        (entry) => entry.type === "refund" && entry.reference === orderId,
      ),
    ).toHaveLength(1);
    expect(service.createRefund("admin", saleId, "refund-one").id).toBe(r.id);
    expect(r.paymentId).toBe(p.id);
  });
  it("queries an unknown refund before resubmitting and reuses the original number", async () => {
    const { orderId } = await paidOrder(),
      saleId = await approvedSale(orderId, 1);
    const r = service.createRefund("admin", saleId, randomUUID());
    gateway.failRefund = true;
    await service.refreshRefund(r.id);
    expect(refund(r.id).status).toBe("unknown");
    expect(() => assertPaymentsClosable(sql, user.id)).toThrow("暂不能注销");
    gateway.failRefund = false;
    await service.refreshRefund(r.id, true);
    expect(gateway.refunded).toEqual([r.id, r.id]);
  });
  it("recovers durable callback inbox after constructing a new worker", async () => {
    const id = await newOrder(),
      p = service.create(
        user.id,
        id,
        "wechat_native",
        randomUUID(),
        "127.0.0.1",
      );
    await service.refresh(p.id);
    service.receive("wechatpay", {
      id: "persisted",
      kind: "payment",
      result: {
        ...gateway.results.get(p.id)!,
        status: "succeeded",
        succeededAt: new Date().toISOString(),
        providerTransactionId: "wx-recovered",
      },
    });
    const restarted = new PaymentService(sql, service.options);
    restarted.processWebhooks();
    expect(payment(p.id).status).toBe("succeeded");
    expect(
      sql
        .prepare(
          "SELECT status FROM production_webhooks WHERE event_id='persisted'",
        )
        .get()!.status,
    ).toBe("done");
  });
  it("records channel-only, local-only, duplicate and amount differences without rewriting ledger", async () => {
    const { p } = await paidOrder();
    const date = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    sql
      .prepare("UPDATE production_payments SET settle_date=? WHERE id=?")
      .run(date, p.id);
    gateway.billRows = [
      { kind: "payment", merchantOrderNo: p.id, amount: p.amount + 1, fee: 3 },
      { kind: "payment", merchantOrderNo: p.id, amount: p.amount, fee: 3 },
      {
        kind: "payment",
        merchantOrderNo: "SMp0000000000000000000000000000",
        amount: 50,
        fee: 1,
      },
    ];
    const before = db().ledger.length,
      report = service.requestReconciliation("wechatpay", date);
    await service.runDue();
    expect(
      sql
        .prepare("SELECT differences FROM production_reconciliation WHERE id=?")
        .get(String(report.id))!.differences,
    ).toBe(3);
    expect(db().ledger).toHaveLength(before);
    expect(() => assertPaymentsClosable(sql, user.id)).toThrow("对账差异");
  });
});
