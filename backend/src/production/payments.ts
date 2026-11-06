import type { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import express, { type Express } from "express";
import { z } from "zod";
import type { Database, Order } from "../../../shared/domain/types";
import type {
  Payment,
  PaymentChannel,
  PaymentProvider,
  Refund,
} from "../../../shared/domain/production";
import {
  readDatabase,
  writeDatabase,
  transaction,
  queryRecord,
} from "../database";
import { releaseSnapshot } from "../storage";
import { HttpError, findSession, rateLimit } from "../auth";
import { demand } from "../permissions";
import { applyPaidOrder, applyRefund } from "../commerce";
import { releaseCoupon, availableStock } from "../commerce-rules";
import { audit } from "../runtime";
import { requireVerifiedContact } from "./accounts";
import { enqueueNotification } from "./external";
import { productionConfig } from "./config";
import {
  configuredGateways,
  GatewayError,
  type BillEntry,
  type GatewayEvent,
  type PaymentGateway,
  type PaymentResult,
  type RefundResult,
} from "./payment-providers";

type StoredPayment = Payment & {
  expiresAt: string;
  ip: string;
  settledAt?: string;
  deadlineCloseStarted?: boolean;
};
type StoredRefund = Refund & { settledAt?: string };
export interface PaymentOptions {
  mode: "demo" | "production";
  channels: PaymentChannel[];
  gateways: Partial<Record<PaymentProvider, PaymentGateway>>;
}
export function paymentOptions(): PaymentOptions {
  const config = productionConfig();
  return {
    mode: config.mode,
    channels: config.paymentChannels,
    gateways: configuredGateways(config.paymentChannels, config.publicUrl),
  };
}
const iso = () => new Date().toISOString();
const day = (date = new Date()) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
const yesterday = () => day(new Date(Date.now() - 86_400_000));
const activePayment = new Set(["creating", "pending", "unknown"]);
const activeRefund = new Set(["pending", "unknown", "processing", "abnormal"]);
const gatewayCode = (error: unknown) =>
  error instanceof GatewayError ? error.code : "PROVIDER_RESPONSE_INVALID";

export function ensurePaymentSchema(sql: DatabaseSync) {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS production_payments(id TEXT PRIMARY KEY,order_id TEXT NOT NULL REFERENCES biz_orders(key),user_id TEXT NOT NULL,provider TEXT NOT NULL,status TEXT NOT NULL,request_id TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),next_attempt_at INTEGER NOT NULL,settle_date TEXT,UNIQUE(user_id,request_id));
    CREATE UNIQUE INDEX IF NOT EXISTS production_payment_active ON production_payments(order_id) WHERE status NOT IN ('closed','failed');
    CREATE UNIQUE INDEX IF NOT EXISTS production_payment_transaction ON production_payments(provider,json_extract(data,'$.providerTransactionId')) WHERE json_extract(data,'$.providerTransactionId') IS NOT NULL;
    CREATE INDEX IF NOT EXISTS production_payment_due ON production_payments(status,next_attempt_at);
    CREATE TABLE IF NOT EXISTS production_refunds(id TEXT PRIMARY KEY,payment_id TEXT NOT NULL REFERENCES production_payments(id),order_id TEXT NOT NULL,after_sale_id TEXT NOT NULL,user_id TEXT NOT NULL,provider TEXT NOT NULL,status TEXT NOT NULL,request_id TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),next_attempt_at INTEGER NOT NULL,settle_date TEXT,UNIQUE(user_id,request_id));
    CREATE UNIQUE INDEX IF NOT EXISTS production_refund_active ON production_refunds(after_sale_id) WHERE status!='failed';
    CREATE INDEX IF NOT EXISTS production_refund_due ON production_refunds(status,next_attempt_at);
    CREATE TABLE IF NOT EXISTS production_webhooks(provider TEXT NOT NULL,event_id TEXT NOT NULL,hash TEXT NOT NULL,payload TEXT NOT NULL CHECK(json_valid(payload)),status TEXT NOT NULL DEFAULT 'pending',error_code TEXT,created_at TEXT NOT NULL,PRIMARY KEY(provider,event_id));
    CREATE TABLE IF NOT EXISTS production_reconciliation(id TEXT PRIMARY KEY,provider TEXT NOT NULL,bill_date TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at INTEGER NOT NULL DEFAULT 0,differences INTEGER NOT NULL DEFAULT 0,reviewed INTEGER NOT NULL DEFAULT 0,review_note TEXT,created_at TEXT NOT NULL,error_code TEXT,UNIQUE(provider,bill_date));
    CREATE TABLE IF NOT EXISTS production_reconciliation_items(id TEXT PRIMARY KEY,report_id TEXT NOT NULL REFERENCES production_reconciliation(id),kind TEXT NOT NULL,merchant_no TEXT NOT NULL,code TEXT,expected INTEGER,actual INTEGER,fee INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS production_reconciliation_report ON production_reconciliation_items(report_id);
  `);
}
function business<T>(
  sql: DatabaseSync,
  orderId: string,
  change: (db: Database, order: Order) => T,
) {
  const db = readDatabase(sql, { orderIds: [orderId] });
  try {
    const order = db.orders.find((value) => value.id === orderId);
    if (!order) throw new HttpError(404, "订单不存在");
    const result = change(db, order);
    db.revision++;
    writeDatabase(sql, db);
    return result;
  } finally {
    releaseSnapshot(db);
  }
}
function getPayment(sql: DatabaseSync, id: string): StoredPayment {
  const row = sql
    .prepare("SELECT data FROM production_payments WHERE id=?")
    .get(id);
  if (!row) throw new HttpError(404, "支付单不存在");
  return JSON.parse(String(row.data));
}
function getRefund(sql: DatabaseSync, id: string): StoredRefund {
  const row = sql
    .prepare("SELECT data FROM production_refunds WHERE id=?")
    .get(id);
  if (!row) throw new HttpError(404, "退款单不存在");
  return JSON.parse(String(row.data));
}
function savePayment(sql: DatabaseSync, payment: StoredPayment) {
  payment.updatedAt = iso();
  sql
    .prepare(
      "UPDATE production_payments SET status=?,data=?,next_attempt_at=?,settle_date=? WHERE id=?",
    )
    .run(
      payment.status,
      JSON.stringify(payment),
      Date.now() + Math.min(3_600_000, 5000 * 2 ** payment.attempts),
      payment.settledAt ? day(new Date(payment.settledAt)) : null,
      payment.id,
    );
}
function saveRefund(sql: DatabaseSync, refund: StoredRefund) {
  refund.updatedAt = iso();
  sql
    .prepare(
      "UPDATE production_refunds SET status=?,data=?,next_attempt_at=?,settle_date=? WHERE id=?",
    )
    .run(
      refund.status,
      JSON.stringify(refund),
      Date.now() + Math.min(3_600_000, 5000 * 2 ** refund.attempts),
      refund.settledAt ? day(new Date(refund.settledAt)) : null,
      refund.id,
    );
}
function requestReceipt(
  sql: DatabaseSync,
  actor: string,
  method: string,
  request: string,
  input: unknown,
  result?: string,
) {
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex");
  const prior = sql
    .prepare(
      "SELECT fingerprint,result FROM command_results WHERE actor_id=? AND method=? AND request_id=?",
    )
    .get(actor, method, request);
  if (prior) {
    if (prior.fingerprint !== fingerprint)
      throw new HttpError(
        409,
        "请求标识已用于其他内容",
        "IDEMPOTENCY_CONFLICT",
      );
    return JSON.parse(String(prior.result)) as string;
  }
  if (result !== undefined)
    sql
      .prepare("INSERT INTO command_results VALUES(?,?,?,?,?,?)")
      .run(actor, method, request, fingerprint, JSON.stringify(result), iso());
  return result;
}
export function publicPayment(payment: StoredPayment): Payment {
  const { ip: _ip, expiresAt: _expiry, ...publicValue } = payment;
  return publicValue;
}

export class PaymentService {
  private inFlight = new Map<string, Promise<void>>();
  private running = false;
  constructor(
    public sql: DatabaseSync,
    public options: PaymentOptions,
  ) {
    ensurePaymentSchema(sql);
  }
  private gateway(payment: Pick<Payment, "provider" | "merchantId">) {
    const gateway = this.options.gateways[payment.provider];
    if (!gateway || gateway.merchantId !== payment.merchantId)
      throw new GatewayError("PAYMENT_MERCHANT_UNAVAILABLE");
    return gateway;
  }
  create(
    userId: string,
    orderId: string,
    channel: PaymentChannel,
    requestId: string,
    ip: string,
  ) {
    if (
      this.options.mode !== "production" ||
      !this.options.channels.includes(channel)
    )
      throw new HttpError(403, "当前支付渠道未启用");
    const provider = channel.startsWith("wechat_") ? "wechatpay" : "alipay";
    const gateway = this.options.gateways[provider];
    if (!gateway) throw new HttpError(503, "支付渠道未配置");
    return transaction(this.sql, () => {
      const args = { orderId, channel };
      const receipt = requestReceipt(
        this.sql,
        userId,
        "payment.create",
        requestId,
        args,
      );
      if (receipt) return getPayment(this.sql, receipt);
      const remember = (payment: StoredPayment) => {
        requestReceipt(
          this.sql,
          userId,
          "payment.create",
          requestId,
          args,
          payment.id,
        );
        return payment;
      };
      const prior = this.sql
        .prepare(
          "SELECT data FROM production_payments WHERE user_id=? AND request_id=?",
        )
        .get(userId, requestId);
      if (prior) {
        const payment: StoredPayment = JSON.parse(String(prior.data));
        if (payment.orderId !== orderId || payment.channel !== channel)
          throw new HttpError(
            409,
            "请求标识已用于其他支付",
            "IDEMPOTENCY_CONFLICT",
          );
        return remember(payment);
      }
      return business(this.sql, orderId, (db, order) => {
        if (order.userId !== userId) throw new HttpError(404, "订单不存在");
        requireVerifiedContact(this.sql, userId);
        if (order.transactionMode !== "production")
          throw new HttpError(409, "历史模拟订单不能使用真实支付");
        if (
          order.status !== "pending" ||
          order.cancelRequested ||
          !order.expiresAt ||
          order.expiresAt <= iso()
        )
          throw new HttpError(409, "订单已超时或不能付款");
        const existing = this.sql
          .prepare(
            "SELECT data FROM production_payments WHERE order_id=? AND status NOT IN ('closed','failed')",
          )
          .get(order.id);
        if (existing) {
          const value: StoredPayment = JSON.parse(String(existing.data));
          if (value.channel === channel) return remember(value);
          throw new HttpError(
            409,
            "请先关闭现有支付单，再切换渠道",
            "PAYMENT_CHANNEL_IN_USE",
          );
        }
        for (const item of order.items) {
          const product = db.products.find(
            (value) => value.id === item.productId,
          );
          if (
            !product?.active ||
            availableStock(db, item.productId, item.skuId, order.id) <
              item.quantity
          )
            throw new HttpError(409, "商品已下架或库存不足");
        }
        const at = iso();
        const payment: StoredPayment = {
          id: `SMp${randomUUID().replaceAll("-", "").slice(0, 28)}`,
          userId,
          orderId,
          channel,
          provider,
          merchantId: gateway.merchantId,
          amount: order.total,
          currency: "CNY",
          status: "creating",
          closeRequested: false,
          attempts: 0,
          createdAt: at,
          updatedAt: at,
          expiresAt: order.expiresAt,
          ip,
        };
        this.sql
          .prepare(
            "INSERT INTO production_payments(id,order_id,user_id,provider,status,request_id,data,next_attempt_at) VALUES(?,?,?,?,?,?,?,?)",
          )
          .run(
            payment.id,
            orderId,
            userId,
            provider,
            payment.status,
            requestId,
            JSON.stringify(payment),
            Date.now(),
          );
        order.paymentHold = true;
        audit(
          this.sql,
          userId,
          "payment.create",
          requestId,
          "pending",
          payment.id,
        );
        return remember(payment);
      });
    });
  }
  applyPayment(id: string, result: PaymentResult) {
    const payment = getPayment(this.sql, id);
    if (
      result.merchantOrderNo !== payment.id ||
      result.merchantId !== payment.merchantId ||
      result.amount !== payment.amount ||
      result.currency !== "CNY"
    )
      throw new GatewayError("PAYMENT_FACTS_MISMATCH");
    if (payment.status === "succeeded") {
      if (
        result.status === "succeeded" &&
        result.providerTransactionId &&
        payment.providerTransactionId !== result.providerTransactionId
      )
        throw new GatewayError("PAYMENT_TRANSACTION_CONFLICT");
      return;
    }
    if (result.status === "succeeded") {
      if (!result.providerTransactionId)
        throw new GatewayError("PAYMENT_TRANSACTION_MISSING");
      if (
        !result.succeededAt ||
        !Number.isFinite(Date.parse(result.succeededAt))
      )
        throw new GatewayError("PAYMENT_SUCCESS_TIME_MISSING");
      business(this.sql, payment.orderId, (db, order) => {
        if (order.status !== "pending")
          throw new GatewayError("PAYMENT_ORDER_STATE_CONFLICT");
        applyPaidOrder(db, order, "provider", result.succeededAt);
        enqueueNotification(this.sql, {
          userId: order.userId,
          orderId: order.id,
          event: "payment",
          eventId: payment.id,
          text: "订单付款成功",
          variables: { orderId: order.id },
        });
      });
      payment.settledAt = result.succeededAt;
      payment.providerTransactionId = result.providerTransactionId;
    } else if (payment.status === "closed" || payment.status === "failed")
      return;
    payment.status = result.status;
    delete payment.errorCode;
    if (result.status === "closed" || result.status === "failed")
      this.release(payment);
    savePayment(this.sql, payment);
  }
  private release(payment: StoredPayment) {
    business(this.sql, payment.orderId, (db, order) => {
      order.paymentHold = false;
      if (
        order.status === "pending" &&
        (order.cancelRequested || order.expiresAt! <= iso())
      ) {
        order.status = "cancelled";
        order.cancelledAt = iso();
        order.cancelReason ??= "付款超时";
        order.events.push({
          at: iso(),
          actor: "system",
          action: "cancelled",
          note: order.cancelReason,
        });
        releaseCoupon(db, order);
        enqueueNotification(this.sql, {
          userId: order.userId,
          orderId: order.id,
          event: "cancelled",
          text: "订单已关闭，库存预占已释放",
          variables: { orderId: order.id },
        });
      }
    });
  }
  close(id: string, userId: string, requestId?: string) {
    return transaction(this.sql, () => {
      const payment = getPayment(this.sql, id);
      if (payment.userId !== userId) throw new HttpError(404, "支付单不存在");
      if (
        requestId &&
        requestReceipt(this.sql, userId, "payment.close", requestId, {
          paymentId: id,
        }) !== undefined
      )
        return payment;
      if (activePayment.has(payment.status)) {
        payment.closeRequested = true;
        payment.attempts = 0;
        savePayment(this.sql, payment);
        this.sql
          .prepare(
            "UPDATE production_payments SET next_attempt_at=0 WHERE id=?",
          )
          .run(id);
      }
      if (requestId)
        requestReceipt(
          this.sql,
          userId,
          "payment.close",
          requestId,
          { paymentId: id },
          id,
        );
      return payment;
    });
  }
  async refresh(id: string) {
    const existing = this.inFlight.get(id);
    if (existing) return existing;
    const running = this.refreshPayment(id);
    this.inFlight.set(id, running);
    try {
      await running;
    } finally {
      this.inFlight.delete(id);
    }
  }
  private async refreshPayment(id: string) {
    let payment = getPayment(this.sql, id);
    if (!activePayment.has(payment.status)) return;
    try {
      const gateway = this.gateway(payment);
      const order = queryRecord<Order>(this.sql, "orders", payment.orderId)!;
      let closing =
        payment.closeRequested ||
        order.cancelRequested ||
        payment.expiresAt <= iso();
      if (payment.status === "creating" && !closing) {
        transaction(this.sql, () => {
          const current = getPayment(this.sql, id);
          current.status = "unknown";
          delete current.checkout;
          savePayment(this.sql, current);
        });
        const checkout = await gateway.create(payment, {
          description: `ShopMate 订单 ${order.id}`,
          expiresAt: payment.expiresAt,
          ip: payment.ip,
        });
        transaction(this.sql, () => {
          const current = getPayment(this.sql, id);
          if (activePayment.has(current.status)) {
            current.checkout = checkout;
            current.status = "pending";
            savePayment(this.sql, current);
          }
        });
        return;
      }
      const result = await gateway.query(payment);
      if (result) {
        transaction(this.sql, () => this.applyPayment(id, result));
        if (result.status !== "pending") return;
      }
      payment = getPayment(this.sql, id);
      if (!activePayment.has(payment.status)) return;
      closing =
        payment.closeRequested ||
        queryRecord<Order>(this.sql, "orders", payment.orderId)!
          .cancelRequested ||
        payment.expiresAt <= iso();
      if (closing) {
        if (result) await gateway.close(payment);
        // A generated checkout can still be opened when the channel has no trade yet.
        // Preserve its reservation until the signed checkout itself expires.
        if (result || payment.expiresAt <= iso())
          transaction(this.sql, () =>
            this.applyPayment(id, {
              merchantOrderNo: payment.id,
              merchantId: payment.merchantId,
              amount: payment.amount,
              currency: "CNY",
              status: "closed",
            }),
          );
      } else if (
        (!result && payment.status === "unknown") ||
        (result?.status === "pending" &&
          (!payment.checkout ||
            (payment.channel === "wechat_h5" &&
              (!payment.checkout.expiresAt ||
                payment.checkout.expiresAt <= iso()))))
      ) {
        transaction(this.sql, () => {
          const current = getPayment(this.sql, id);
          current.status = "unknown";
          // Re-entry can invalidate the previous H5 URL even if its response is lost.
          delete current.checkout;
          savePayment(this.sql, current);
        });
        const checkout = await gateway.create(payment, {
          description: `ShopMate 订单 ${order.id}`,
          expiresAt: payment.expiresAt,
          ip: payment.ip,
        });
        transaction(this.sql, () => {
          const current = getPayment(this.sql, id);
          if (activePayment.has(current.status)) {
            current.checkout = checkout;
            current.status = "pending";
            savePayment(this.sql, current);
          }
        });
      }
      transaction(this.sql, () => {
        payment = getPayment(this.sql, id);
        if (activePayment.has(payment.status)) {
          payment.attempts++;
          savePayment(this.sql, payment);
        }
      });
    } catch (error) {
      transaction(this.sql, () => {
        const current = getPayment(this.sql, id);
        if (!activePayment.has(current.status)) return;
        current.errorCode = gatewayCode(error);
        current.attempts++;
        const rejectedCreate =
          payment.status === "creating" &&
          error instanceof GatewayError &&
          !error.ambiguous &&
          ["WECHAT_REQUEST_FAILED", "ALIPAY_REJECTED"].includes(error.code);
        current.status = rejectedCreate ? "failed" : "unknown";
        if (rejectedCreate) this.release(current);
        savePayment(this.sql, current);
      });
    }
  }
  createRefund(actorId: string, afterSaleId: string, requestId: string) {
    return transaction(this.sql, () => {
      const receipt = requestReceipt(
        this.sql,
        actorId,
        "refund.create",
        requestId,
        { afterSaleId },
      );
      if (receipt) return getRefund(this.sql, receipt);
      const remember = (refund: StoredRefund) => {
        requestReceipt(
          this.sql,
          actorId,
          "refund.create",
          requestId,
          { afterSaleId },
          refund.id,
        );
        return refund;
      };
      const prior = this.sql
        .prepare(
          "SELECT data FROM production_refunds WHERE user_id=? AND request_id=?",
        )
        .get(actorId, requestId);
      if (prior) {
        const refund: StoredRefund = JSON.parse(String(prior.data));
        if (refund.afterSaleId !== afterSaleId)
          throw new HttpError(409, "请求标识已用于其他退款");
        return remember(refund);
      }
      const link = this.sql
        .prepare("SELECT order_id FROM biz_after_sales WHERE key=?")
        .get(afterSaleId);
      if (!link) throw new HttpError(404, "售后不存在");
      return business(this.sql, String(link.order_id), (db, order) => {
        const sale = db.afterSales.find((value) => value.id === afterSaleId)!;
        if (order.transactionMode !== "production")
          throw new HttpError(409, "历史模拟订单不能发起渠道退款");
        const active = this.sql
          .prepare(
            "SELECT data FROM production_refunds WHERE after_sale_id=? AND status!='failed'",
          )
          .get(afterSaleId);
        if (active)
          return remember(JSON.parse(String(active.data)) as StoredRefund);
        const paymentRow = this.sql
          .prepare(
            "SELECT id FROM production_payments WHERE order_id=? AND status='succeeded'",
          )
          .get(order.id);
        if (!paymentRow) throw new HttpError(409, "订单没有成功的真实支付");
        const payment = getPayment(this.sql, String(paymentRow.id));
        const amount = applyRefund(db, sale, order, false, "provider");
        if (amount > 0) this.gateway(payment);
        const reserved = Number(
          this.sql
            .prepare(
              "SELECT coalesce(sum(json_extract(data,'$.amount')),0) amount FROM production_refunds WHERE payment_id=? AND status!='failed'",
            )
            .get(payment.id)?.amount ?? 0,
        );
        if (reserved + amount > payment.amount)
          throw new HttpError(409, "退款总额超出实付金额");
        const at = iso();
        const refund: StoredRefund = {
          id: `SMr${randomUUID().replaceAll("-", "").slice(0, 28)}`,
          paymentId: payment.id,
          orderId: order.id,
          afterSaleId,
          provider: payment.provider,
          amount,
          noTransfer: amount === 0,
          status: "pending",
          attempts: 0,
          createdAt: at,
          updatedAt: at,
        };
        this.sql
          .prepare(
            "INSERT INTO production_refunds(id,payment_id,order_id,after_sale_id,user_id,provider,status,request_id,data,next_attempt_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
          )
          .run(
            refund.id,
            payment.id,
            order.id,
            afterSaleId,
            actorId,
            payment.provider,
            refund.status,
            requestId,
            JSON.stringify(refund),
            Date.now(),
          );
        sale.refundPending = true;
        audit(
          this.sql,
          actorId,
          "refund.create",
          requestId,
          "pending",
          refund.id,
        );
        return remember(refund);
      });
    });
  }
  applyRefund(id: string, result: RefundResult) {
    const refund = getRefund(this.sql, id);
    if (
      result.merchantRefundNo !== id ||
      result.merchantOrderNo !== refund.paymentId ||
      result.amount !== refund.amount
    )
      throw new GatewayError("REFUND_FACTS_MISMATCH");
    if (refund.status === "succeeded") return;
    if (refund.status === "failed") {
      if (result.status === "succeeded")
        throw new GatewayError("REFUND_TERMINAL_CONFLICT");
      return;
    }
    if (result.status === "succeeded") {
      if (
        !result.succeededAt ||
        !Number.isFinite(Date.parse(result.succeededAt))
      )
        throw new GatewayError("REFUND_SUCCESS_TIME_MISSING");
      business(this.sql, refund.orderId, (db, order) => {
        const sale = db.afterSales.find(
          (value) => value.id === refund.afterSaleId,
        )!;
        applyRefund(
          db,
          sale,
          order,
          true,
          refund.noTransfer ? "zero" : "provider",
          result.succeededAt,
        );
        sale.events.push({
          at: iso(),
          actor: "system",
          action: "refund",
          note: refund.noTransfer
            ? "零金额售后结案，无资金流转"
            : "渠道退款成功",
        });
        enqueueNotification(this.sql, {
          userId: order.userId,
          orderId: order.id,
          event: "refund",
          eventId: refund.id,
          text: refund.noTransfer
            ? "零金额售后已完成，无需资金退款"
            : "售后退款成功",
          variables: { orderId: order.id },
        });
      });
      refund.settledAt = result.succeededAt;
    } else if (result.status === "failed")
      business(this.sql, refund.orderId, (db) => {
        db.afterSales.find(
          (sale) => sale.id === refund.afterSaleId,
        )!.refundPending = false;
      });
    refund.status = result.status;
    refund.providerRefundId = result.providerRefundId;
    delete refund.errorCode;
    saveRefund(this.sql, refund);
  }
  async refreshRefund(id: string, retry = false) {
    const key = `refund:${id}`;
    if (this.inFlight.has(key)) return this.inFlight.get(key);
    const pending = this.doRefund(id, retry);
    this.inFlight.set(key, pending);
    try {
      await pending;
    } finally {
      this.inFlight.delete(key);
    }
  }
  private async doRefund(id: string, retry: boolean) {
    const refund = getRefund(this.sql, id);
    if (refund.status === "failed" && retry)
      throw new HttpError(
        409,
        "渠道已确认退款关闭，请在原售后重新发起新的退款单。",
        "REFUND_CLOSED",
      );
    if (refund.status === "succeeded" || refund.status === "failed") return;
    const payment = getPayment(this.sql, refund.paymentId);
    if (refund.noTransfer) {
      transaction(this.sql, () =>
        this.applyRefund(id, {
          merchantRefundNo: id,
          merchantOrderNo: payment.id,
          amount: 0,
          status: "succeeded",
          succeededAt: iso(),
        }),
      );
      return;
    }
    try {
      const gateway = this.gateway(payment);
      if (refund.status === "pending")
        transaction(this.sql, () => {
          const current = getRefund(this.sql, id);
          current.status = "unknown";
          saveRefund(this.sql, current);
        });
      let result =
        refund.status === "pending"
          ? await gateway.refund(refund, payment)
          : await gateway.queryRefund(refund, payment);
      // Unknown submissions are retried only after querying, with the original refund number.
      if (
        !result &&
        refund.status === "unknown" &&
        (retry || refund.attempts < 5)
      )
        result = await gateway.refund(refund, payment);
      transaction(this.sql, () => {
        if (result) this.applyRefund(id, result);
        const current = getRefund(this.sql, id);
        if (activeRefund.has(current.status)) {
          current.attempts++;
          saveRefund(this.sql, current);
        }
      });
    } catch (error) {
      transaction(this.sql, () => {
        const current = getRefund(this.sql, id);
        if (current.status === "succeeded" || current.status === "failed")
          return;
        current.status = "unknown";
        current.errorCode = gatewayCode(error);
        current.attempts++;
        saveRefund(this.sql, current);
      });
    }
  }
  receive(provider: PaymentProvider, event: GatewayEvent) {
    const payload = JSON.stringify(event),
      hash = createHash("sha256").update(payload).digest("hex");
    transaction(this.sql, () => {
      const prior = this.sql
        .prepare(
          "SELECT hash FROM production_webhooks WHERE provider=? AND event_id=?",
        )
        .get(provider, event.id);
      if (prior && prior.hash !== hash)
        throw new GatewayError("WEBHOOK_ID_CONFLICT");
      this.sql
        .prepare(
          "INSERT OR IGNORE INTO production_webhooks(provider,event_id,hash,payload,created_at) VALUES(?,?,?,?,?)",
        )
        .run(provider, event.id, hash, payload, iso());
    });
  }
  processWebhooks() {
    for (const row of this.sql
      .prepare(
        "SELECT provider,event_id,payload FROM production_webhooks WHERE status='pending' ORDER BY created_at LIMIT 20",
      )
      .all()) {
      try {
        transaction(this.sql, () => {
          const event: GatewayEvent = JSON.parse(String(row.payload));
          if (event.kind === "payment") {
            const result = event.result as PaymentResult,
              payment = getPayment(this.sql, result.merchantOrderNo);
            if (payment.provider !== row.provider)
              throw new GatewayError("WEBHOOK_PROVIDER_MISMATCH");
            this.applyPayment(payment.id, result);
          } else {
            const result = event.result as RefundResult,
              refund = getRefund(this.sql, result.merchantRefundNo);
            if (refund.provider !== row.provider)
              throw new GatewayError("WEBHOOK_PROVIDER_MISMATCH");
            this.applyRefund(refund.id, result);
          }
          this.sql
            .prepare(
              "UPDATE production_webhooks SET status='done',error_code=NULL WHERE provider=? AND event_id=?",
            )
            .run(row.provider, row.event_id);
        });
      } catch (error) {
        this.sql
          .prepare(
            "UPDATE production_webhooks SET status='failed',error_code=? WHERE provider=? AND event_id=?",
          )
          .run(gatewayCode(error), row.provider, row.event_id);
      }
    }
  }
  requestReconciliation(provider: PaymentProvider, date: string) {
    if (!this.options.gateways[provider])
      throw new HttpError(400, "渠道未启用");
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      Number.isNaN(Date.parse(date)) ||
      new Date(date).toISOString().slice(0, 10) !== date ||
      date > yesterday()
    )
      throw new HttpError(400, "账单日期必须是已结束的北京时间日期");
    this.sql
      .prepare(
        "INSERT OR IGNORE INTO production_reconciliation(id,provider,bill_date,created_at) VALUES(?,?,?,?)",
      )
      .run(randomUUID(), provider, date, iso());
    return this.sql
      .prepare(
        "SELECT id,provider,bill_date date,status,differences,reviewed,created_at createdAt,error_code errorCode FROM production_reconciliation WHERE provider=? AND bill_date=?",
      )
      .get(provider, date)!;
  }
  private reconcile(
    id: string,
    provider: PaymentProvider,
    date: string,
    entries: BillEntry[],
  ) {
    const expected = new Map<string, number>();
    for (const row of this.sql
      .prepare(
        "SELECT id,json_extract(data,'$.amount') amount FROM production_payments WHERE provider=? AND status='succeeded' AND settle_date=?",
      )
      .all(provider, date))
      expected.set(`payment:${row.id}`, Number(row.amount));
    for (const row of this.sql
      .prepare(
        "SELECT id,json_extract(data,'$.amount') amount FROM production_refunds WHERE provider=? AND status='succeeded' AND settle_date=? AND json_extract(data,'$.amount')>0",
      )
      .all(provider, date))
      expected.set(`refund:${row.id}`, Number(row.amount));
    const actual = new Set<string>();
    let differences = 0;
    this.sql
      .prepare("DELETE FROM production_reconciliation_items WHERE report_id=?")
      .run(id);
    const insert = (
      kind: string,
      merchantNo: string,
      code: string | null,
      expectedAmount: number | null,
      amount: number | null,
      fee = 0,
    ) => {
      if (code) differences++;
      this.sql
        .prepare(
          "INSERT INTO production_reconciliation_items(id,report_id,kind,merchant_no,code,expected,actual,fee) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          randomUUID(),
          id,
          kind,
          merchantNo,
          code,
          expectedAmount,
          amount,
          fee,
        );
    };
    for (const entry of entries) {
      const merchantNo =
        entry.kind === "payment"
          ? entry.merchantOrderNo
          : entry.merchantRefundNo!;
      const key = `${entry.kind}:${merchantNo}`;
      insert(
        entry.kind,
        merchantNo,
        actual.has(key)
          ? "DUPLICATE_CHANNEL_ROW"
          : !expected.has(key)
            ? "CHANNEL_ONLY"
            : expected.get(key) !== entry.amount
              ? "AMOUNT_MISMATCH"
              : null,
        expected.get(key) ?? null,
        entry.amount,
        entry.fee,
      );
      actual.add(key);
    }
    for (const [key, amount] of expected)
      if (!actual.has(key)) {
        const [kind, merchantNo] = key.split(":");
        insert(kind!, merchantNo!, "LOCAL_ONLY", amount, null);
      }
    this.sql
      .prepare(
        "UPDATE production_reconciliation SET status='done',differences=?,reviewed=0,error_code=NULL WHERE id=?",
      )
      .run(differences, id);
  }
  async runDue() {
    if (this.running) return;
    this.running = true;
    try {
      this.processWebhooks();
      // Expired checkout closure has its own attempt budget after ordinary polling stops.
      for (const row of this.sql
        .prepare(
          "SELECT p.id,p.data FROM production_payments p JOIN biz_orders o ON o.key=p.order_id WHERE p.status IN ('creating','pending','unknown') AND ((json_extract(p.data,'$.closeRequested')=0 AND json_extract(o.data,'$.cancelRequested')=1) OR (coalesce(json_extract(p.data,'$.deadlineCloseStarted'),0)=0 AND json_extract(o.data,'$.expiresAt')<=?))",
        )
        .all(iso())) {
        const payment: StoredPayment = JSON.parse(String(row.data));
        payment.closeRequested = true;
        payment.attempts = 0;
        if (payment.expiresAt <= iso()) payment.deadlineCloseStarted = true;
        savePayment(this.sql, payment);
        this.sql
          .prepare(
            "UPDATE production_payments SET next_attempt_at=0 WHERE id=?",
          )
          .run(row.id);
      }
      for (const row of this.sql
        .prepare(
          "SELECT id FROM production_payments WHERE status IN ('creating','pending','unknown') AND next_attempt_at<=? AND json_extract(data,'$.attempts')<5 ORDER BY next_attempt_at LIMIT 5",
        )
        .all(Date.now()))
        await this.refresh(String(row.id));
      for (const row of this.sql
        .prepare(
          "SELECT id FROM production_refunds WHERE status IN ('pending','unknown','processing') AND next_attempt_at<=? AND json_extract(data,'$.attempts')<5 ORDER BY next_attempt_at LIMIT 5",
        )
        .all(Date.now()))
        await this.refreshRefund(String(row.id));
      if (
        this.options.mode === "production" &&
        Number(
          new Intl.DateTimeFormat("en-GB", {
            timeZone: "Asia/Shanghai",
            hour: "2-digit",
            hourCycle: "h23",
          }).format(new Date()),
        ) >= 10
      )
        for (const provider of Object.keys(
          this.options.gateways,
        ) as PaymentProvider[])
          this.requestReconciliation(provider, yesterday());
      const report = this.sql
        .prepare(
          "SELECT * FROM production_reconciliation WHERE status='pending' AND attempts<5 AND next_attempt_at<=? ORDER BY created_at LIMIT 1",
        )
        .get(Date.now());
      if (report) {
        try {
          const entries = await this.options.gateways[
            report.provider as PaymentProvider
          ]!.bill(String(report.bill_date));
          transaction(this.sql, () =>
            this.reconcile(
              String(report.id),
              report.provider as PaymentProvider,
              String(report.bill_date),
              entries,
            ),
          );
        } catch (error) {
          const attempts = Number(report.attempts) + 1;
          this.sql
            .prepare(
              "UPDATE production_reconciliation SET attempts=?,status=?,next_attempt_at=?,error_code=? WHERE id=?",
            )
            .run(
              attempts,
              attempts >= 5 ? "failed" : "pending",
              Date.now() + 60_000 * 2 ** attempts,
              gatewayCode(error),
              report.id,
            );
        }
      }
    } finally {
      this.running = false;
    }
  }
  async drain() {
    await Promise.allSettled([...this.inFlight.values()]);
  }
}

export function registerPaymentWebhooks(app: Express, service: PaymentService) {
  app.post(
    "/api/webhooks/:provider",
    express.raw({
      type: ["application/json", "application/x-www-form-urlencoded"],
      limit: "256kb",
      inflate: false,
    }),
    (req, res, next) => {
      const provider = req.params.provider as PaymentProvider;
      if (provider !== "wechatpay" && provider !== "alipay") return next();
      const gateway = service.options.gateways[provider];
      if (!gateway) return void res.sendStatus(404);
      if (!Buffer.isBuffer(req.body)) return void res.sendStatus(415);
      try {
        service.receive(provider, gateway.webhook(req.body, req.headers));
        if (provider === "wechatpay") res.sendStatus(204);
        else res.type("text/plain").send("success");
      } catch {
        if (provider === "wechatpay")
          res.status(400).json({ code: "FAIL", message: "通知校验失败" });
        else res.status(400).type("text/plain").send("failure");
      }
    },
  );
}
const requestId = z.string().min(1).max(128);
function paginate(
  sql: DatabaseSync,
  req: express.Request,
  table: string,
  select: string,
  where = "1=1",
  args: (string | number)[] = [],
) {
  const page = z.coerce.number().int().min(1).default(1).parse(req.query.page),
    pageSize = z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .parse(req.query.pageSize);
  const total = Number(
    sql
      .prepare(`SELECT count(*) total FROM ${table} WHERE ${where}`)
      .get(...args)?.total ?? 0,
  );
  const items = sql
    .prepare(
      `SELECT ${select} FROM ${table} WHERE ${where} ORDER BY rowid DESC LIMIT ? OFFSET ?`,
    )
    .all(...args, pageSize, (page - 1) * pageSize);
  return {
    items,
    total,
    page,
    pageSize,
    pages: Math.max(1, Math.ceil(total / pageSize)),
  };
}
export function registerPaymentRoutes(app: Express, service: PaymentService) {
  const sql = service.sql;
  const command = (
    actorId: string,
    method: string,
    requestId: string,
    input: unknown,
    execute: () => string,
  ) =>
    transaction(sql, () => {
      const previous = requestReceipt(sql, actorId, method, requestId, input);
      if (previous !== undefined) return previous;
      const result = execute();
      requestReceipt(sql, actorId, method, requestId, input, result);
      return result;
    });
  const owned = (req: express.Request) => {
    const user = findSession(sql, req, "user");
    if (!user) throw new HttpError(401, "请先登录");
    const payment = getPayment(sql, String(req.params.id));
    if (payment.userId !== user.id) throw new HttpError(404, "支付单不存在");
    return payment;
  };
  app.post("/api/payments", async (req, res) => {
    const session = findSession(sql, req, "user");
    if (!session) throw new HttpError(401, "请先登录");
    rateLimit(sql, `payment:${session.id}`, 20, 60_000);
    const body = z
      .object({
        orderId: z.string().min(1).max(100),
        channel: z.enum([
          "wechat_native",
          "wechat_h5",
          "alipay_page",
          "alipay_wap",
        ]),
        requestId,
      })
      .strict()
      .parse(req.body);
    const payment = service.create(
      session.id,
      body.orderId,
      body.channel,
      body.requestId,
      req.ip ?? "",
    );
    await service.refresh(payment.id);
    res.status(201).json(publicPayment(getPayment(sql, payment.id)));
  });
  app.get("/api/payments/:id", (req, res) =>
    res.json(publicPayment(owned(req))),
  );
  app.post("/api/payments/:id/refresh", async (req, res) => {
    const payment = owned(req);
    const body = z.object({ requestId }).strict().parse(req.body);
    rateLimit(sql, `payment-query:${payment.userId}`, 20, 60_000);
    command(
      payment.userId,
      "payment.refresh",
      body.requestId,
      { paymentId: payment.id },
      () => payment.id,
    );
    await service.refresh(payment.id);
    res.json(publicPayment(getPayment(sql, payment.id)));
  });
  app.post("/api/payments/:id/close", async (req, res) => {
    const payment = owned(req);
    const body = z.object({ requestId }).strict().parse(req.body);
    service.close(payment.id, payment.userId, body.requestId);
    await service.refresh(payment.id);
    res.json(publicPayment(getPayment(sql, payment.id)));
  });
  app.get("/api/orders/:id/payments", (req, res) => {
    const session = findSession(sql, req, "user");
    if (!session) throw new HttpError(401, "请先登录");
    const order = queryRecord<Order>(sql, "orders", String(req.params.id));
    if (order?.userId !== session.id) throw new HttpError(404, "订单不存在");
    const payments = sql
      .prepare(
        "SELECT data FROM production_payments WHERE order_id=? ORDER BY rowid DESC",
      )
      .all(order.id)
      .map((row) => publicPayment(JSON.parse(String(row.data))));
    const refunds = sql
      .prepare(
        "SELECT data FROM production_refunds WHERE order_id=? ORDER BY rowid DESC",
      )
      .all(order.id)
      .map((row) => JSON.parse(String(row.data)) as Refund);
    res.json({ payments, refunds });
  });
  app.get("/api/admin/payments", (req, res) => {
    demand(findSession(sql, req, "admin"), "finance");
    const result = paginate(sql, req, "production_payments", "data");
    res.json({
      ...result,
      items: result.items.map((row) =>
        publicPayment(JSON.parse(String(row.data))),
      ),
    });
  });
  app.get("/api/admin/refunds", (req, res) => {
    demand(findSession(sql, req, "admin"), "finance");
    const result = paginate(sql, req, "production_refunds", "data");
    res.json({
      ...result,
      items: result.items.map((row) => JSON.parse(String(row.data))),
    });
  });
  app.post("/api/admin/refunds", async (req, res) => {
    const actor = findSession(sql, req, "admin");
    demand(actor, "finance");
    const body = z
      .object({ afterSaleId: z.string().min(1).max(100), requestId })
      .strict()
      .parse(req.body);
    const refund = service.createRefund(
      actor!.id,
      body.afterSaleId,
      body.requestId,
    );
    await service.refreshRefund(refund.id);
    res.status(201).json(getRefund(sql, refund.id));
  });
  app.post("/api/admin/payments/:id/refresh", async (req, res) => {
    const actor = findSession(sql, req, "admin");
    demand(actor, "finance");
    const body = z.object({ requestId }).strict().parse(req.body);
    const payment = getPayment(sql, String(req.params.id));
    command(
      actor!.id,
      "payment.refresh",
      body.requestId,
      { paymentId: payment.id },
      () => payment.id,
    );
    await service.refresh(payment.id);
    res.json(publicPayment(getPayment(sql, payment.id)));
  });
  for (const action of ["refresh", "retry"])
    app.post(`/api/admin/refunds/:id/${action}`, async (req, res) => {
      const actor = findSession(sql, req, "admin");
      demand(actor, "finance");
      const body = z.object({ requestId }).strict().parse(req.body);
      const refund = getRefund(sql, String(req.params.id));
      command(
        actor!.id,
        `refund.${action}`,
        body.requestId,
        { refundId: refund.id },
        () => refund.id,
      );
      await service.refreshRefund(refund.id, action === "retry");
      res.json(getRefund(sql, refund.id));
    });
  app.get("/api/admin/channel-reconciliation", (req, res) => {
    demand(findSession(sql, req, "admin"), "finance");
    res.json(
      paginate(
        sql,
        req,
        "production_reconciliation",
        "id,provider,bill_date date,status,differences,reviewed,created_at createdAt,error_code errorCode",
      ),
    );
  });
  app.post("/api/admin/channel-reconciliation", (req, res) => {
    const actor = findSession(sql, req, "admin");
    demand(actor, "finance");
    const body = z
      .object({
        provider: z.enum(["wechatpay", "alipay"]),
        date: z.string(),
        requestId,
      })
      .strict()
      .parse(req.body);
    const reportId = command(
      actor!.id,
      "reconciliation.request",
      body.requestId,
      { provider: body.provider, date: body.date },
      () => {
        const value = service.requestReconciliation(body.provider, body.date);
        audit(
          sql,
          actor!.id,
          "reconciliation.request",
          body.requestId,
          "pending",
          String(value.id),
        );
        return String(value.id);
      },
    );
    const report = sql
      .prepare(
        "SELECT id,provider,bill_date date,status,differences,reviewed,created_at createdAt,error_code errorCode FROM production_reconciliation WHERE id=?",
      )
      .get(reportId);
    res.status(202).json(report);
  });
  app.get("/api/admin/channel-reconciliation/:id", (req, res) => {
    demand(findSession(sql, req, "admin"), "finance");
    res.json(
      paginate(
        sql,
        req,
        "production_reconciliation_items",
        "id,kind,merchant_no merchantNo,code,expected,actual,fee",
        "report_id=?",
        [String(req.params.id)],
      ),
    );
  });
  app.post("/api/admin/channel-reconciliation/:id/retry", (req, res) => {
    const actor = findSession(sql, req, "admin");
    demand(actor, "finance");
    const body = z.object({ requestId }).strict().parse(req.body),
      reportId = String(req.params.id);
    transaction(sql, () => {
      if (
        requestReceipt(sql, actor!.id, "reconciliation.retry", body.requestId, {
          reportId,
        })
      )
        return;
      const row = sql
        .prepare("SELECT status FROM production_reconciliation WHERE id=?")
        .get(reportId);
      if (!row) throw new HttpError(404, "对账记录不存在");
      if (row.status === "pending") throw new HttpError(409, "对账正在处理中");
      sql
        .prepare(
          "UPDATE production_reconciliation SET status='pending',attempts=0,next_attempt_at=0,reviewed=0,error_code=NULL WHERE id=?",
        )
        .run(reportId);
      requestReceipt(
        sql,
        actor!.id,
        "reconciliation.retry",
        body.requestId,
        { reportId },
        reportId,
      );
      audit(
        sql,
        actor!.id,
        "reconciliation.retry",
        body.requestId,
        "pending",
        reportId,
      );
    });
    res.json({ id: reportId, status: "pending" });
  });
  app.post("/api/admin/channel-reconciliation/:id/review", (req, res) => {
    const actor = findSession(sql, req, "admin");
    demand(actor, "finance");
    const body = z
      .object({ note: z.string().trim().min(1).max(500), requestId })
      .strict()
      .parse(req.body);
    command(
      actor!.id,
      "reconciliation.review",
      body.requestId,
      { reportId: String(req.params.id), note: body.note },
      () => {
        const row = sql
          .prepare("SELECT status FROM production_reconciliation WHERE id=?")
          .get(String(req.params.id));
        if (!row) throw new HttpError(404, "对账记录不存在");
        if (row.status !== "done") throw new HttpError(409, "对账尚未完成");
        sql
          .prepare(
            "UPDATE production_reconciliation SET reviewed=1,review_note=? WHERE id=?",
          )
          .run(body.note, String(req.params.id));
        audit(
          sql,
          actor!.id,
          "reconciliation.review",
          body.requestId,
          "reviewed",
          String(req.params.id),
        );
        return String(req.params.id);
      },
    );
    res.json({ ok: true });
  });
  app.get("/api/admin/webhooks", (req, res) => {
    demand(findSession(sql, req, "admin"), "finance");
    res.json(
      paginate(
        sql,
        req,
        "production_webhooks",
        "provider,event_id eventId,status,error_code errorCode,created_at createdAt",
      ),
    );
  });
  app.post("/api/admin/webhooks/:provider/:id/retry", (req, res) => {
    const actor = findSession(sql, req, "admin");
    demand(actor, "finance");
    const body = z.object({ requestId }).strict().parse(req.body);
    const provider = String(req.params.provider),
      eventId = String(req.params.id);
    command(
      actor!.id,
      "webhook.retry",
      body.requestId,
      { provider, eventId },
      () => {
        const result = sql
          .prepare(
            "UPDATE production_webhooks SET status='pending',error_code=NULL WHERE provider=? AND event_id=? AND status='failed'",
          )
          .run(provider, eventId);
        if (!result.changes)
          throw new HttpError(409, "通知不存在或不处于失败状态");
        audit(
          sql,
          actor!.id,
          "webhook.retry",
          body.requestId,
          "pending",
          String(req.params.id),
        );
        return eventId;
      },
    );
    res.json({ ok: true });
  });
}

export function paymentCounts(sql: DatabaseSync) {
  return {
    paymentsUnknown: Number(
      sql
        .prepare(
          "SELECT count(*) n FROM production_payments WHERE status='unknown' OR (status IN ('creating','pending') AND json_extract(data,'$.attempts')>=5)",
        )
        .get()?.n ?? 0,
    ),
    refundsPending: Number(
      sql
        .prepare(
          "SELECT count(*) n FROM production_refunds WHERE status IN ('pending','unknown','processing','abnormal')",
        )
        .get()?.n ?? 0,
    ),
    webhooksFailed: Number(
      sql
        .prepare(
          "SELECT count(*) n FROM production_webhooks WHERE status='failed'",
        )
        .get()?.n ?? 0,
    ),
    reconciliationDifferences: Number(
      sql
        .prepare(
          "SELECT coalesce(sum(differences),0) n FROM production_reconciliation WHERE reviewed=0",
        )
        .get()?.n ?? 0,
    ),
  };
}
export function assertPaymentsClosable(sql: DatabaseSync, userId: string) {
  if (
    sql
      .prepare(
        "SELECT 1 FROM production_payments WHERE user_id=? AND status IN ('creating','pending','unknown')",
      )
      .get(userId) ||
    sql
      .prepare(
        "SELECT 1 FROM production_refunds r JOIN production_payments p ON p.id=r.payment_id WHERE p.user_id=? AND r.status IN ('pending','unknown','processing','abnormal')",
      )
      .get(userId)
  )
    throw new HttpError(409, "仍有待核对的支付或退款，暂不能注销");
  if (
    sql
      .prepare(
        "SELECT 1 FROM production_reconciliation_items i JOIN production_reconciliation r ON r.id=i.report_id JOIN production_payments p ON p.id=i.merchant_no OR p.id=(SELECT payment_id FROM production_refunds WHERE id=i.merchant_no) WHERE p.user_id=? AND r.reviewed=0 AND i.code IS NOT NULL",
      )
      .get(userId)
  )
    throw new HttpError(409, "仍有本人交易对账差异，暂不能注销");
}

export function anonymizePaymentAccount(sql: DatabaseSync, userId: string) {
  sql
    .prepare(
      "UPDATE production_payments SET data=json_remove(data,'$.ip') WHERE user_id=?",
    )
    .run(userId);
}
