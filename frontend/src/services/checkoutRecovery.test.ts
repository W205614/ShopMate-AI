import { beforeEach, expect, it } from "vitest";
import {
  clearCheckoutRecovery,
  checkoutRecoveryPath,
  loadCheckoutRecovery,
  saveCheckoutRecovery,
} from "./checkoutRecovery";
beforeEach(() => sessionStorage.clear());
it("retains only purchase identifiers in a canonical checkout path", () => {
  expect(
    checkoutRecoveryPath(
      "/checkout?quantity=2&address=private&skuId=s&productId=p#private",
    ),
  ).toBe("/checkout?productId=p&skuId=s&quantity=2");
});
it("stores identifiers only and isolates users with a 24 hour lifetime", () => {
  const marker = {
    userId: "u1",
    quoteId: "quote",
    requestId: "request",
    checkoutPath: "/checkout?productId=p01",
    createdAt: Date.now(),
  };
  saveCheckoutRecovery(marker);
  expect(loadCheckoutRecovery("u1")).toEqual(marker);
  expect(loadCheckoutRecovery("u2")).toBeNull();
  expect(loadCheckoutRecovery("u1", marker.createdAt + 86400001)).toBeNull();
});
it("rejects unsafe paths and clears only the requested user's marker", () => {
  expect(() =>
    saveCheckoutRecovery({
      userId: "u1",
      quoteId: "quote",
      requestId: "request",
      checkoutPath: "//evil.example",
      createdAt: Date.now(),
    }),
  ).toThrow();
  saveCheckoutRecovery({
    userId: "u2",
    quoteId: "quote",
    requestId: "request",
    checkoutPath: "/checkout",
    createdAt: Date.now(),
  });
  clearCheckoutRecovery("u1");
  expect(loadCheckoutRecovery("u2")?.quoteId).toBe("quote");
});
it("a completed older recovery cannot clear a newer marker", () => {
  const old = {
    userId: "u1",
    quoteId: "q1",
    requestId: "r1",
    checkoutPath: "/checkout",
    createdAt: Date.now(),
  };
  const next = { ...old, quoteId: "q2", requestId: "r2" };
  saveCheckoutRecovery(next);
  clearCheckoutRecovery("u1", old);
  expect(loadCheckoutRecovery("u1")).toEqual(next);
  clearCheckoutRecovery("u1", next);
  expect(loadCheckoutRecovery("u1")).toBeNull();
});
