import express, { type ErrorRequestHandler } from "express";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { tokenHash } from "../src/auth";
import { registerPaymentRoutes } from "../src/production/payments";
import { createPaymentFixture, storedPayment } from "./support/payment-fixture";

let fixture: ReturnType<typeof createPaymentFixture>,
  server: Server,
  base: string;
beforeEach(async () => {
  vi.stubEnv("SHOP_MODE", "demo");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-06T02:00:00Z"));
  fixture = createPaymentFixture();
  for (const [role, id] of [
    ["user", "u1"],
    ["admin", "admin"],
  ])
    fixture.sql
      .prepare(
        "INSERT INTO sessions(token_hash,account_id,expires_at,mfa_verified) VALUES(?,?,?,1)",
      )
      .run(tokenHash(`binding-${role}`), id, Date.now() + 60_000);
  const app = express();
  app.use(express.json());
  registerPaymentRoutes(app, fixture.service);
  const errors: ErrorRequestHandler = (error, _req, res, _next) =>
    res
      .status(error.status ?? 500)
      .json({ code: error.code, message: error.message });
  app.use(errors);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((done) => server.once("listening", done));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  fixture.sql.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
const post = (path: string, body: unknown, role = "admin") =>
  fetch(base + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `shopmate_${role}=binding-${role}`,
    },
    body: JSON.stringify(body),
  });
async function pending() {
  const orderId = await fixture.order();
  const payment = fixture.service.create(
    "u1",
    orderId,
    "wechat_native",
    randomUUID(),
    "127.0.0.1",
  );
  await fixture.service.refresh(payment.id);
  return payment;
}

it.each([
  ["user", "refresh", "/api/payments"],
  ["user", "close", "/api/payments"],
  ["admin", "refresh", "/api/admin/payments"],
])(
  "binds %s payment %s before network activity and rejects a different target",
  async (role, action, prefix) => {
    const first = await pending(),
      second = await pending();
    const query = vi.spyOn(fixture.gateway, "query"),
      close = vi.spyOn(fixture.gateway, "close");
    const body = { requestId: "bound-payment-command" };
    expect(
      (await post(`${prefix}/${first.id}/${action}`, body, role)).status,
    ).toBe(200);
    const calls = query.mock.calls.length;
    expect(
      (await post(`${prefix}/${second.id}/${action}`, body, role)).status,
    ).toBe(409);
    expect(query).toHaveBeenCalledTimes(calls);
    expect(storedPayment(fixture.sql, second.id).closeRequested).toBe(false);
    expect(close.mock.calls.every(([value]) => value.id === first.id)).toBe(
      true,
    );
    expect(
      (await post(`${prefix}/${first.id}/${action}`, body, role)).status,
    ).toBe(200);
  },
);

it.each(["refresh", "retry"])(
  "binds refund %s to its original refund before provider activity",
  async (action) => {
    const refunds = [];
    for (let index = 0; index < 2; index++) {
      const { orderId } = await fixture.paid();
      refunds.push(
        fixture.service.createRefund(
          "admin",
          await fixture.sale(orderId),
          `new-refund-${index}`,
        ),
      );
    }
    const refund = vi.spyOn(fixture.gateway, "refund");
    expect(
      (
        await post(`/api/admin/refunds/${refunds[0]!.id}/${action}`, {
          requestId: "bound-refund",
        })
      ).status,
    ).toBe(200);
    const calls = refund.mock.calls.length;
    expect(
      (
        await post(`/api/admin/refunds/${refunds[1]!.id}/${action}`, {
          requestId: "bound-refund",
        })
      ).status,
    ).toBe(409);
    expect(refund).toHaveBeenCalledTimes(calls);
  },
);

it("keeps the payment refresh request bound while the original provider query is still in flight", async () => {
  const first = await pending(),
    second = await pending();
  let release!: () => void, started!: () => void;
  const wait = new Promise<void>((done) => {
    release = done;
  });
  const requested = new Promise<void>((done) => {
    started = done;
  });
  const original = fixture.gateway.query.bind(fixture.gateway);
  const query = vi
    .spyOn(fixture.gateway, "query")
    .mockImplementation(async (payment) => {
      started();
      await wait;
      return original(payment);
    });
  const body = { requestId: "in-flight-binding" };
  const response = post(`/api/payments/${first.id}/refresh`, body, "user");
  await requested;
  try {
    expect(
      (await post(`/api/payments/${second.id}/refresh`, body, "user")).status,
    ).toBe(409);
    expect(query).toHaveBeenCalledTimes(1);
  } finally {
    release();
  }
  expect((await response).status).toBe(200);
});

it("binds reconciliation parameters and review notes without duplicate side effects", async () => {
  const request = {
    provider: "wechatpay",
    date: "2026-11-01",
    requestId: "request-report",
  };
  const first = await post("/api/admin/channel-reconciliation", request);
  expect(first.status).toBe(202);
  const report = await first.json();
  expect(
    (
      await post("/api/admin/channel-reconciliation", {
        ...request,
        date: "2026-11-02",
      })
    ).status,
  ).toBe(409);
  expect(
    fixture.sql
      .prepare("SELECT count(*) n FROM production_reconciliation")
      .get()!.n,
  ).toBe(1);
  fixture.sql
    .prepare("UPDATE production_reconciliation SET status='done' WHERE id=?")
    .run(report.id);
  const review = { requestId: "review-report", note: "已核实原始渠道账单" };
  expect(
    (
      await post(
        `/api/admin/channel-reconciliation/${report.id}/review`,
        review,
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await post(`/api/admin/channel-reconciliation/${report.id}/review`, {
        ...review,
        note: "另一段备注",
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await post(
        `/api/admin/channel-reconciliation/${report.id}/review`,
        review,
      )
    ).status,
  ).toBe(200);
  expect(
    fixture.sql
      .prepare("SELECT review_note FROM production_reconciliation WHERE id=?")
      .get(report.id)!.review_note,
  ).toBe(review.note);
});

it("does not reschedule a later failed webhook generation by replaying an old retry command", async () => {
  fixture.sql
    .prepare(
      "INSERT INTO production_webhooks(provider,event_id,hash,payload,status,created_at) VALUES('wechatpay','retry-one','hash','{}','failed',?)",
    )
    .run(new Date().toISOString());
  const path = "/api/admin/webhooks/wechatpay/retry-one/retry",
    body = { requestId: "original-generation" };
  expect((await post(path, body)).status).toBe(200);
  fixture.sql
    .prepare(
      "UPDATE production_webhooks SET status='failed',error_code='SECOND_FAILURE' WHERE event_id='retry-one'",
    )
    .run();
  expect((await post(path, body)).status).toBe(200);
  expect(
    fixture.sql
      .prepare(
        "SELECT status,error_code FROM production_webhooks WHERE event_id='retry-one'",
      )
      .get(),
  ).toMatchObject({ status: "failed", error_code: "SECOND_FAILURE" });
});
