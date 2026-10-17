import { expect, it } from "vitest";
import type { AfterSale, Order } from "./types";
import { afterSaleState } from "./afterSaleState";
it("keeps cancellation and return receipt prerequisites aligned for both roles", () => {
  const sale = {
    orderId: "order",
    userId: "u1",
    status: "approved",
    requiresReturn: true,
  } as AfterSale;
  const order = { id: "order", userId: "u1", status: "completed" } as Order;
  expect(afterSaleState(sale, order)).toMatchObject({
    canCancel: true,
    canReturn: true,
    canReceive: false,
    canRefund: false,
  });
  sale.status = "returning";
  sale.returnTracking = "R";
  expect(afterSaleState(sale, order).canReceive).toBe(false);
  sale.returnCarrier = "模拟退货";
  expect(afterSaleState(sale, order)).toMatchObject({
    canCancel: false,
    canReceive: true,
  });
  sale.status = "received";
  expect(afterSaleState(sale, order).canRefund).toBe(true);
  order.status = "refunded";
  expect(afterSaleState(sale, order).canRefund).toBe(false);
});
it("distinguishes refund-only approval from return logistics and completed history", () => {
  const sale = {
    orderId: "order",
    userId: "u1",
    status: "approved",
    requiresReturn: false,
  } as AfterSale;
  const order = { id: "order", userId: "u1", status: "paid" } as Order;
  expect(afterSaleState(sale, order)).toMatchObject({
    canCancel: true,
    canReturn: false,
    canRefund: true,
  });
  sale.returnTracking = "legacy";
  expect(afterSaleState(sale, order).canCancel).toBe(false);
  sale.status = "refunded";
  expect(afterSaleState(sale, order)).toMatchObject({
    canCancel: false,
    canReturn: false,
    canReceive: false,
    canRefund: false,
  });
  expect(afterSaleState(sale, order).guidance).toContain("本次退款已完成");
});
