import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readDatabase, transaction } from "../src/database";
import {
  GatewayError,
  type PaymentGateway,
  type PaymentResult,
} from "../src/production/payment-providers";
import { PaymentService } from "../src/production/payments";
import { createPaymentFixture, storedPayment } from "./support/payment-fixture";

let fixture: ReturnType<typeof createPaymentFixture>;
beforeEach(() => {
  vi.stubEnv("SHOP_MODE", "demo");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-06T02:00:00Z"));
  fixture = createPaymentFixture();
});
afterEach(() => {
  fixture.sql.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function checkout() {
  const { service, user, order, sql } = fixture;
  const gateway: PaymentGateway = fixture.gateway;
  const originalCreate = gateway.create.bind(gateway);
  const create = vi
    .spyOn(gateway, "create")
    .mockImplementation(async (payment, input) => {
      expect(storedPayment(sql, payment.id)).toMatchObject({
        status: "unknown",
      });
      expect(storedPayment(sql, payment.id).checkout).toBeUndefined();
      await originalCreate(payment, input);
      return {
        kind: "redirect",
        value: `https://wx.tenpay.com/cgi-bin/mmpayweb-bin/checkmweb?prepay_id=${payment.id}-${fixture.gateway.created.length}`,
        expiresAt: new Date(
          Math.min(Date.now() + 5 * 60_000, Date.parse(input.expiresAt)),
        ).toISOString(),
      };
    });
  const payment = service.create(
    user.id,
    await order(),
    "wechat_h5",
    "h5-original",
    "203.0.113.1",
  );
  await service.refresh(payment.id);
  return { payment, create, gateway };
}

it("reuses a live checkout and renews only its expiry under the original payment with a refresh latch", async () => {
  const { service, sql, user } = fixture;
  const { payment, create, gateway } = await checkout();
  const first = storedPayment(sql, payment.id).checkout!;
  const close = vi.spyOn(gateway, "close");
  await service.refresh(payment.id);
  expect(create).toHaveBeenCalledTimes(1);
  expect(storedPayment(sql, payment.id).checkout).toEqual(first);
  vi.setSystemTime(Date.parse(first.expiresAt!));
  await Promise.all([service.refresh(payment.id), service.refresh(payment.id)]);
  const renewed = storedPayment(sql, payment.id);
  expect(renewed.status).toBe("pending");
  expect(renewed.checkout!.value).not.toBe(first.value);
  expect(Date.parse(renewed.checkout!.expiresAt!)).toBe(
    Date.now() + 5 * 60_000,
  );
  expect(fixture.gateway.created).toEqual([payment.id, payment.id]);
  expect(close).not.toHaveBeenCalled();
  expect(
    service.create(
      user.id,
      payment.orderId,
      "wechat_h5",
      "h5-replay",
      "203.0.113.1",
    ).id,
  ).toBe(payment.id);
  expect(
    sql.prepare("SELECT count(*) n FROM production_payments").get()!.n,
  ).toBe(1);
  expect(
    readDatabase(sql).ledger.filter(
      (entry) => entry.reference === payment.orderId,
    ),
  ).toHaveLength(0);
  await service.refresh(payment.id);
  expect(create).toHaveBeenCalledTimes(2);
});

it("clears the old H5 URL before a lost renewal response and recovers from durable state after restart", async () => {
  const { service, sql } = fixture;
  const { payment, create, gateway } = await checkout();
  const first = storedPayment(sql, payment.id).checkout!;
  const successfulCreate = create.getMockImplementation()!;
  create.mockImplementationOnce(async (value, input) => {
    await successfulCreate(value, input);
    throw new GatewayError("PROVIDER_RESPONSE_LOST", true);
  });
  vi.setSystemTime(Date.parse(first.expiresAt!));
  await service.refresh(payment.id);
  expect(storedPayment(sql, payment.id)).toMatchObject({
    status: "unknown",
    errorCode: "PROVIDER_RESPONSE_LOST",
  });
  expect(storedPayment(sql, payment.id).checkout).toBeUndefined();
  const restored = new PaymentService(sql, {
    mode: "production",
    channels: ["wechat_h5"],
    gateways: { wechatpay: gateway },
  });
  const query = vi.spyOn(gateway, "query");
  await restored.refresh(payment.id);
  expect(query).toHaveBeenCalledWith(
    expect.objectContaining({ id: payment.id, status: "unknown" }),
  );
  expect(storedPayment(sql, payment.id)).toMatchObject({
    status: "pending",
    checkout: { kind: "redirect" },
  });
  expect(fixture.gateway.created).toEqual([payment.id, payment.id, payment.id]);
  expect(
    sql.prepare("SELECT count(*) n FROM production_payments").get()!.n,
  ).toBe(1);
});

it.each(["query", "callback"] as const)(
  "does not recreate an expired checkout when payment succeeds via %s",
  async (source) => {
    const { service, sql } = fixture;
    const { payment, create, gateway } = await checkout();
    const pending = fixture.gateway.payments.get(payment.id)!;
    const paid: PaymentResult = {
      ...pending,
      status: "succeeded",
      providerTransactionId: `paid-${payment.id}`,
      succeededAt: new Date().toISOString(),
    };
    vi.setSystemTime(
      Date.parse(storedPayment(sql, payment.id).checkout!.expiresAt!),
    );
    if (source === "query") fixture.gateway.payments.set(payment.id, paid);
    else
      vi.spyOn(gateway, "query").mockImplementationOnce(async () => {
        transaction(sql, () => service.applyPayment(payment.id, paid));
        return pending;
      });
    await service.refresh(payment.id);
    expect(storedPayment(sql, payment.id).status).toBe("succeeded");
    expect(create).toHaveBeenCalledTimes(1);
    expect(
      readDatabase(sql).ledger.filter(
        (entry) =>
          entry.type === "payment" && entry.reference === payment.orderId,
      ),
    ).toHaveLength(1);
  },
);

it("queries and renews historical H5 links without expiry metadata only once", async () => {
  const { service, sql } = fixture;
  const { payment, create } = await checkout();
  sql
    .prepare(
      "UPDATE production_payments SET data=json_remove(data,'$.checkout.expiresAt') WHERE id=?",
    )
    .run(payment.id);
  await service.refresh(payment.id);
  expect(storedPayment(sql, payment.id).checkout!.expiresAt).toBeDefined();
  await service.refresh(payment.id);
  expect(create).toHaveBeenCalledTimes(2);
});
