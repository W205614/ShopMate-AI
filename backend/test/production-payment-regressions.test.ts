import express, { type ErrorRequestHandler } from "express";
import type { Server } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tokenHash } from "../src/auth";
import { readDatabase, transaction } from "../src/database";
import {
  GatewayError,
  type RefundResult,
} from "../src/production/payment-providers";
import {
  PaymentService,
  registerPaymentRoutes,
} from "../src/production/payments";
import {
  createPaymentFixture,
  storedPayment,
  storedRefund,
} from "./support/payment-fixture";

let fixture: ReturnType<typeof createPaymentFixture>,
  server: Server | undefined;
beforeEach(() => {
  vi.stubEnv("SHOP_MODE", "demo");
  fixture = createPaymentFixture();
});
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
  fixture.sql.close();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
const now = () => new Date().toISOString();
function refundResult(
  id: string,
  paymentId: string,
  amount: number,
  status: RefundResult["status"],
): RefundResult {
  return {
    merchantRefundNo: id,
    merchantOrderNo: paymentId,
    amount,
    status,
    providerRefundId: `provider-${id}`,
    ...(status === "succeeded" ? { succeededAt: now() } : {}),
  };
}
describe("production lifecycle regressions found in independent review", () => {
  it("binds every reused active-payment request ID even after closure and rejects a new target or channel", async () => {
    const { service, user, order, sql } = fixture;
    const orderId = await order(),
      first = service.create(
        user.id,
        orderId,
        "wechat_native",
        "original",
        "127.0.0.1",
      );
    await service.refresh(first.id);
    expect(
      service.create(user.id, orderId, "wechat_native", "alias", "127.0.0.1")
        .id,
    ).toBe(first.id);
    service.close(first.id, user.id);
    await service.refresh(first.id);
    expect(storedPayment(sql, first.id).status).toBe("closed");
    expect(
      service.create(user.id, orderId, "wechat_native", "alias", "127.0.0.1")
        .id,
    ).toBe(first.id);
    expect(() =>
      service.create(user.id, orderId, "wechat_h5", "alias", "127.0.0.1"),
    ).toThrow("请求标识");
    const secondOrder = await order();
    expect(() =>
      service.create(
        user.id,
        secondOrder,
        "wechat_native",
        "alias",
        "127.0.0.1",
      ),
    ).toThrow("请求标识");
    expect(
      sql.prepare("SELECT count(*) count FROM production_payments").get()!
        .count,
    ).toBe(1);
  });
  it("binds active-refund aliases so replay after a definitive failure cannot create another refund", async () => {
    const { service, paid, sale, sql } = fixture;
    const { orderId, payment } = await paid(),
      saleId = await sale(orderId);
    const refund = service.createRefund("admin", saleId, "refund-original");
    expect(service.createRefund("admin", saleId, "refund-alias").id).toBe(
      refund.id,
    );
    transaction(sql, () =>
      service.applyRefund(
        refund.id,
        refundResult(refund.id, payment.id, refund.amount, "failed"),
      ),
    );
    expect(service.createRefund("admin", saleId, "refund-alias").id).toBe(
      refund.id,
    );
    expect(() =>
      service.createRefund("admin", "different-sale", "refund-alias"),
    ).toThrow("请求标识");
    expect(
      sql.prepare("SELECT count(*) count FROM production_refunds").get()!.count,
    ).toBe(1);
  });
  it("keeps a definitive refund failure terminal under late processing/abnormal events and records contradictory success", async () => {
    const { service, paid, sale, sql } = fixture;
    const { orderId, payment } = await paid(),
      saleId = await sale(orderId),
      refund = service.createRefund("admin", saleId, randomUUID());
    transaction(sql, () =>
      service.applyRefund(
        refund.id,
        refundResult(refund.id, payment.id, refund.amount, "failed"),
      ),
    );
    for (const status of ["processing", "abnormal"] as const) {
      service.receive("wechatpay", {
        id: `late-${status}`,
        kind: "refund",
        result: refundResult(refund.id, payment.id, refund.amount, status),
      });
      service.processWebhooks();
      expect(storedRefund(sql, refund.id).status).toBe("failed");
      expect(
        readDatabase(sql).afterSales.find(
          (candidate) => candidate.id === saleId,
        )!.refundPending,
      ).toBe(false);
    }
    service.receive("wechatpay", {
      id: "contradictory-success",
      kind: "refund",
      result: refundResult(refund.id, payment.id, refund.amount, "succeeded"),
    });
    service.processWebhooks();
    expect(
      sql
        .prepare(
          "SELECT status,error_code FROM production_webhooks WHERE event_id='contradictory-success'",
        )
        .get(),
    ).toMatchObject({
      status: "failed",
      error_code: "REFUND_TERMINAL_CONFLICT",
    });
    expect(
      readDatabase(sql).orders.find((candidate) => candidate.id === orderId)!
        .refundedAmount,
    ).toBe(0);
  });
  it("attributes a delayed payment to the provider success day and uses that time in order and ledger", async () => {
    const { service, gateway, sql, order, user } = fixture;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-11-03T15:30:00.000Z");
    const orderId = await order(),
      payment = service.create(
        user.id,
        orderId,
        "wechat_native",
        randomUUID(),
        "127.0.0.1",
      );
    await service.refresh(payment.id);
    vi.setSystemTime("2026-11-05T02:00:00.000Z");
    const succeededAt = "2026-11-03T15:59:59.000Z";
    service.receive("wechatpay", {
      id: "delayed-payment",
      kind: "payment",
      result: {
        ...gateway.payments.get(payment.id)!,
        status: "succeeded",
        providerTransactionId: "delayed-transaction",
        succeededAt,
      },
    });
    service.processWebhooks();
    expect(
      sql
        .prepare("SELECT settle_date FROM production_payments WHERE id=?")
        .get(payment.id)!.settle_date,
    ).toBe("2026-11-03");
    const db = readDatabase(sql);
    expect(
      db.orders.find((candidate) => candidate.id === orderId)!.paidAt,
    ).toBe(succeededAt);
    expect(
      db.ledger.find(
        (entry) => entry.type === "payment" && entry.reference === orderId,
      )!.createdAt,
    ).toBe(succeededAt);
  });
  it("attributes a delayed refund to its provider success day across the Beijing midnight boundary", async () => {
    const { service, gateway, sql, paid, sale } = fixture;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-11-03T15:30:00.000Z");
    const { orderId, payment } = await paid();
    vi.setSystemTime("2026-11-03T15:50:00.000Z");
    const saleId = await sale(orderId),
      refund = service.createRefund("admin", saleId, randomUUID());
    await service.refreshRefund(refund.id);
    vi.setSystemTime("2026-11-05T02:00:00.000Z");
    const succeededAt = "2026-11-03T16:00:01.000Z";
    const result = {
      ...gateway.refunds.get(refund.id)!,
      status: "succeeded" as const,
      succeededAt,
    };
    service.receive("wechatpay", {
      id: "delayed-refund",
      kind: "refund",
      result,
    });
    service.processWebhooks();
    expect(
      sql
        .prepare("SELECT settle_date FROM production_refunds WHERE id=?")
        .get(refund.id)!.settle_date,
    ).toBe("2026-11-04");
    expect(
      readDatabase(sql).ledger.find(
        (entry) => entry.type === "refund" && entry.reference === orderId,
      )!.createdAt,
    ).toBe(succeededAt);
    expect(refund.paymentId).toBe(payment.id);
  });
  it("rejects success evidence without channel time instead of silently attributing it to receipt day", async () => {
    const { service, gateway, sql, order, user } = fixture;
    const orderId = await order(),
      payment = service.create(
        user.id,
        orderId,
        "wechat_native",
        randomUUID(),
        "127.0.0.1",
      );
    await service.refresh(payment.id);
    expect(() =>
      transaction(sql, () =>
        service.applyPayment(payment.id, {
          ...gateway.payments.get(payment.id)!,
          status: "succeeded",
          providerTransactionId: "missing-time",
        }),
      ),
    ).toThrow("PAYMENT_SUCCESS_TIME_MISSING");
    expect(storedPayment(sql, payment.id).status).toBe("pending");
    expect(
      readDatabase(sql).orders.find((candidate) => candidate.id === orderId)!
        .status,
    ).toBe("pending");
  });
  it("persists unknown before payment submission and recovers a channel success after restart without another create", async () => {
    const { service, gateway, sql, order, user } = fixture;
    const orderId = await order(),
      payment = service.create(
        user.id,
        orderId,
        "wechat_native",
        randomUUID(),
        "127.0.0.1",
      );
    gateway.onCreate = (value) => {
      expect(storedPayment(sql, value.id).status).toBe("unknown");
      throw new GatewayError("AFTER_PROVIDER_ACCEPTED", true);
    };
    await service.refresh(payment.id);
    expect(storedPayment(sql, payment.id).status).toBe("unknown");
    gateway.onCreate = undefined;
    gateway.payments.set(payment.id, {
      ...gateway.payments.get(payment.id)!,
      status: "succeeded",
      succeededAt: now(),
      providerTransactionId: "accepted-before-crash",
    });
    const restarted = new PaymentService(sql, service.options);
    await restarted.refresh(payment.id);
    expect(storedPayment(sql, payment.id).status).toBe("succeeded");
    expect(gateway.created).toEqual([payment.id]);
    expect(
      readDatabase(sql).ledger.filter(
        (entry) => entry.type === "payment" && entry.reference === orderId,
      ),
    ).toHaveLength(1);
  });
  it("persists unknown before refund submission and recovers without issuing the accepted refund again", async () => {
    const { service, gateway, sql, paid, sale } = fixture;
    const { orderId } = await paid(),
      saleId = await sale(orderId),
      refund = service.createRefund("admin", saleId, randomUUID());
    gateway.onRefund = (value) => {
      expect(storedRefund(sql, value.id).status).toBe("unknown");
      throw new GatewayError("REFUND_ACCEPTED_BEFORE_CRASH", true);
    };
    await service.refreshRefund(refund.id);
    gateway.onRefund = undefined;
    gateway.refunds.set(refund.id, {
      ...gateway.refunds.get(refund.id)!,
      status: "succeeded",
      succeededAt: now(),
    });
    const restarted = new PaymentService(sql, service.options);
    await restarted.refreshRefund(refund.id);
    expect(storedRefund(sql, refund.id).status).toBe("succeeded");
    expect(gateway.submittedRefunds).toEqual([refund.id]);
    expect(
      readDatabase(sql).ledger.filter(
        (entry) => entry.type === "refund" && entry.reference === orderId,
      ),
    ).toHaveLength(1);
  });
  it("retries a failed bill and rebuilds a completed report through an authenticated idempotent HTTP command", async () => {
    const { service, gateway, sql } = fixture;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-11-06T00:00:00.000Z");
    const date = "2026-11-01",
      report = service.requestReconciliation("wechatpay", date),
      id = String(report.id);
    sql
      .prepare(
        "UPDATE production_reconciliation SET status='failed',attempts=5,error_code='BILL_TEMPORARILY_UNAVAILABLE' WHERE id=?",
      )
      .run(id);
    sql
      .prepare(
        "INSERT INTO production_reconciliation_items(id,report_id,kind,merchant_no,code,expected,actual,fee) VALUES('previous-generation',?,'payment','SMp0000000000000000000000000000','LOCAL_ONLY',100,NULL,0)",
      )
      .run(id);
    const token = randomBytes(32).toString("hex");
    sql
      .prepare(
        "INSERT INTO sessions(token_hash,account_id,expires_at,mfa_verified) VALUES(?,'admin',?,1)",
      )
      .run(tokenHash(token), Date.now() + 60_000);
    const app = express();
    app.use(express.json());
    registerPaymentRoutes(app, service);
    const onError: ErrorRequestHandler = (error, _req, res, _next) =>
      res
        .status(error.status ?? 500)
        .json({ message: error.message, code: error.code });
    app.use(onError);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const post = (requestId: string, cookie = `shopmate_admin=${token}`) =>
      fetch(`${base}/api/admin/channel-reconciliation/${id}/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ requestId }),
      });
    expect((await post("forbidden", "")).status).toBe(401);
    expect((await post("retry-command")).status).toBe(200);
    expect(
      sql
        .prepare(
          "SELECT count(*) n FROM production_reconciliation_items WHERE report_id=?",
        )
        .get(id)!.n,
    ).toBe(1);
    await service.runDue();
    expect(
      sql
        .prepare("SELECT status FROM production_reconciliation WHERE id=?")
        .get(id)!.status,
    ).toBe("done");
    const calls = gateway.billCalls;
    expect((await post("retry-command")).status).toBe(200);
    await service.runDue();
    expect(gateway.billCalls).toBe(calls);
    gateway.billRows = [
      {
        kind: "payment",
        merchantOrderNo: "SMp0000000000000000000000000000",
        amount: 100,
        fee: 1,
      },
    ];
    expect((await post("rebuild-command")).status).toBe(200);
    await service.runDue();
    expect(
      sql
        .prepare(
          "SELECT status,differences FROM production_reconciliation WHERE id=?",
        )
        .get(id),
    ).toMatchObject({ status: "done", differences: 1 });
  });
});
