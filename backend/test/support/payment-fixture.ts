import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  openDatabase,
  readDatabase,
  transaction,
  writeDatabase,
} from "../../src/database";
import { context } from "../../src/repository";
import { commerceApi } from "../../src/commerce";
import { ensureRuntimeSchema } from "../../src/runtime";
import {
  ensureAccountSchema,
  readMerchant,
} from "../../src/production/accounts";
import { ensureExternalSchema } from "../../src/production/external";
import { PaymentService } from "../../src/production/payments";
import {
  type BillEntry,
  type GatewayEvent,
  type PaymentGateway,
  type PaymentResult,
  type RefundResult,
} from "../../src/production/payment-providers";
import type { Payment, Refund } from "../../../shared/domain/production";
import type { Database, Session } from "../../../shared/domain/types";
import { createSeed } from "../../../shared/domain/seed";

/** A provider boundary fixture; inventory, refunds, permissions and ledger behavior remain real. */
export class RegressionGateway implements PaymentGateway {
  provider = "wechatpay" as const;
  merchantId = "regression-merchant";
  payments = new Map<string, PaymentResult>();
  refunds = new Map<string, RefundResult>();
  created: string[] = [];
  submittedRefunds: string[] = [];
  billRows: BillEntry[] = [];
  billCalls = 0;
  failBill = false;
  onCreate?: (payment: Payment) => void;
  onRefund?: (refund: Refund) => void;
  async create(payment: Payment) {
    this.created.push(payment.id);
    this.payments.set(payment.id, {
      merchantOrderNo: payment.id,
      merchantId: this.merchantId,
      amount: payment.amount,
      currency: "CNY",
      status: "pending",
    });
    this.onCreate?.(payment);
    return {
      kind: "qr" as const,
      value: `weixin://wxpay/regression/${payment.id}`,
    };
  }
  async query(payment: Payment) {
    return this.payments.get(payment.id) ?? null;
  }
  async close(payment: Payment) {
    const result = this.payments.get(payment.id);
    if (result && result.status !== "succeeded") result.status = "closed";
  }
  async refund(refund: Refund, payment: Payment) {
    this.submittedRefunds.push(refund.id);
    const result: RefundResult = {
      merchantRefundNo: refund.id,
      merchantOrderNo: payment.id,
      amount: refund.amount,
      status: "processing",
      providerRefundId: `refund-${refund.id}`,
    };
    this.refunds.set(refund.id, result);
    this.onRefund?.(refund);
    return result;
  }
  async queryRefund(refund: Refund) {
    return this.refunds.get(refund.id) ?? null;
  }
  webhook(raw: Buffer): GatewayEvent {
    return JSON.parse(raw.toString("utf8")) as GatewayEvent;
  }
  async bill() {
    this.billCalls++;
    if (this.failBill) throw new Error("BILL_TEMPORARILY_UNAVAILABLE");
    return this.billRows;
  }
}

export function storedPayment(sql: DatabaseSync, id: string): Payment {
  return JSON.parse(
    String(
      sql.prepare("SELECT data FROM production_payments WHERE id=?").get(id)!
        .data,
    ),
  );
}
export function storedRefund(sql: DatabaseSync, id: string): Refund {
  return JSON.parse(
    String(
      sql.prepare("SELECT data FROM production_refunds WHERE id=?").get(id)!
        .data,
    ),
  );
}
export function createPaymentFixture() {
  const sql = openDatabase(":memory:");
  writeDatabase(sql, createSeed());
  ensureRuntimeSchema(sql);
  ensureAccountSchema(sql);
  ensureExternalSchema(sql);
  sql
    .prepare(
      "INSERT INTO accounts(id,username,name,role,password_hash,created_at) VALUES('u1','regression_user','回归顾客','user','fixture-not-a-login-secret',1),('admin','regression_owner','回归店主','admin','fixture-not-a-login-secret',1)",
    )
    .run();
  sql.prepare("INSERT INTO staff_access VALUES('admin','owner',1)").run();
  sql
    .prepare(
      "INSERT INTO verified_contacts VALUES('u1','email','regression@example.test',1)",
    )
    .run();
  const merchant = readMerchant(sql);
  Object.assign(merchant, {
    legalName: "回归测试商家",
    serviceEmail: "support@example.test",
    returnAddress: "测试退货地址",
    privacy: { version: "p1", title: "隐私", text: "测试政策" },
    terms: { version: "t1", title: "服务", text: "测试协议" },
  });
  sql
    .prepare("UPDATE merchant_profile SET data=? WHERE id=1")
    .run(JSON.stringify(merchant));
  sql
    .prepare(
      "INSERT INTO policy_consents VALUES('u1','privacy','p1',1),('u1','terms','t1',1)",
    )
    .run();
  const user: Session = { id: "u1", name: "回归顾客", role: "user" },
    admin: Session = {
      id: "admin",
      name: "回归店主",
      role: "admin",
      staffRole: "owner",
    };
  const gateway = new RegressionGateway();
  const service = new PaymentService(sql, {
    mode: "production",
    channels: ["wechat_native", "wechat_h5"],
    gateways: { wechatpay: gateway },
  });
  const invoke = <T>(action: () => T) =>
    context.run({ sql, user, admin }, action);
  const change = (action: (database: Database) => void) => {
    const db = readDatabase(sql);
    action(db);
    writeDatabase(sql, db);
  };
  const order = async (quantity = 1) => {
    const quote = await invoke(() =>
      commerceApi.quoteCheckout({
        addressId: "a1",
        source: { type: "buyNow", productId: "p01", skuId: "p01-s1", quantity },
      }),
    );
    const id = await invoke(() =>
      commerceApi.createOrder({ quoteId: quote.id, requestId: randomUUID() }),
    );
    change((db) => {
      db.orders.find((candidate) => candidate.id === id)!.transactionMode =
        "production";
    });
    return id;
  };
  const paid = async (quantity = 1, succeededAt = new Date().toISOString()) => {
    const orderId = await order(quantity),
      payment = service.create(
        user.id,
        orderId,
        "wechat_native",
        randomUUID(),
        "127.0.0.1",
      );
    await service.refresh(payment.id);
    const result: PaymentResult = {
      ...gateway.payments.get(payment.id)!,
      status: "succeeded",
      providerTransactionId: `paid-${payment.id}`,
      succeededAt,
    };
    gateway.payments.set(payment.id, result);
    transaction(sql, () => service.applyPayment(payment.id, result));
    return { orderId, payment };
  };
  const sale = async (orderId: string, quantity = 1) => {
    const target = readDatabase(sql).orders.find(
      (candidate) => candidate.id === orderId,
    )!;
    await invoke(() =>
      commerceApi.requestAfterSale(orderId, "测试售后", "合成资料", [
        { orderItemId: target.items[0]!.id, quantity },
      ]),
    );
    const saleId = readDatabase(sql).afterSales.find(
      (candidate) => candidate.orderId === orderId,
    )!.id;
    await invoke(() => commerceApi.processAfterSale(saleId, "approve"));
    return saleId;
  };
  return {
    sql,
    gateway,
    service,
    user,
    admin,
    invoke,
    change,
    order,
    paid,
    sale,
  };
}
