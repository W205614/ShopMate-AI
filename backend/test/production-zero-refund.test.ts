import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readDatabase } from "../src/database";
import { createPaymentFixture, storedRefund } from "./support/payment-fixture";

let fixture: ReturnType<typeof createPaymentFixture>;
beforeEach(() => {
  vi.stubEnv("SHOP_MODE", "demo");
  vi.stubEnv("SMTP_HOST", "");
  vi.stubEnv("SMS_ENABLED", "false");
  vi.stubEnv("KUAIDI100_ENABLED", "false");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime("2026-11-02T02:00:00.000Z");
  fixture = createPaymentFixture();
});
afterEach(() => {
  fixture.sql.close();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it("settles a zero allocated partial refund once without a provider transfer or a channel reconciliation difference", async () => {
  const { sql, service, gateway, change, paid, sale } = fixture;
  change((db) => {
    db.products
      .find((product) => product.id === "p01")!
      .skus.find((sku) => sku.id === "p01-s1")!.price = 1;
    db.promotions = [
      {
        id: "zero-allocation-promotion",
        name: "两分商品优惠一分",
        threshold: 2,
        discount: 1,
        startsAt: "2026-11-01T00:00:00.000Z",
        endsAt: "2026-11-30T00:00:00.000Z",
        active: true,
        version: 1,
      },
    ];
  });
  const { orderId, payment } = await paid(2);
  const before = readDatabase(sql),
    order = before.orders.find((item) => item.id === orderId)!;
  expect(order.items[0].total).toBe(1);
  const stock = before.products
    .find((product) => product.id === "p01")!
    .skus.find((sku) => sku.id === "p01-s1")!.stock;
  const saleId = await sale(orderId, 1),
    requestId = randomUUID(),
    refund = service.createRefund("admin", saleId, requestId);
  const providerRefund = vi.spyOn(gateway, "refund"),
    providerQuery = vi.spyOn(gateway, "queryRefund");
  expect(refund).toMatchObject({
    amount: 0,
    noTransfer: true,
    status: "pending",
  });
  await service.refreshRefund(refund.id);
  await service.refreshRefund(refund.id);
  expect(service.createRefund("admin", saleId, requestId).id).toBe(refund.id);
  expect(storedRefund(sql, refund.id)).toMatchObject({
    amount: 0,
    noTransfer: true,
    status: "succeeded",
  });
  expect(providerRefund).not.toHaveBeenCalled();
  expect(providerQuery).not.toHaveBeenCalled();
  const after = readDatabase(sql),
    afterOrder = after.orders.find((item) => item.id === orderId)!;
  expect(after.afterSales.find((item) => item.id === saleId)).toMatchObject({
    status: "refunded",
    refundPending: false,
  });
  expect(afterOrder.items[0].refundedQuantity).toBe(1);
  expect(afterOrder.refundedAmount).toBe(0);
  expect(
    after.products
      .find((product) => product.id === "p01")!
      .skus.find((sku) => sku.id === "p01-s1")!.stock,
  ).toBe(stock + 1);
  expect(
    after.ledger.filter(
      (item) => item.type === "refund" && item.reference === orderId,
    ),
  ).toHaveLength(1);
  expect(
    after.ledger.find(
      (item) => item.type === "refund" && item.reference === orderId,
    ),
  ).toMatchObject({ amount: 0 });
  gateway.billRows = [
    {
      kind: "payment",
      merchantOrderNo: payment.id,
      amount: payment.amount,
      fee: 0,
    },
  ];
  vi.setSystemTime("2026-11-03T02:00:00.000Z");
  const report = service.requestReconciliation("wechatpay", "2026-11-02");
  await service.runDue();
  expect(
    sql
      .prepare(
        "SELECT status,differences FROM production_reconciliation WHERE id=?",
      )
      .get(String(report.id)),
  ).toMatchObject({ status: "done", differences: 0 });
  expect(
    sql
      .prepare(
        "SELECT count(*) count FROM production_reconciliation_items WHERE report_id=? AND merchant_no=?",
      )
      .get(String(report.id), refund.id)?.count,
  ).toBe(0);
  expect(providerRefund).not.toHaveBeenCalled();
});
