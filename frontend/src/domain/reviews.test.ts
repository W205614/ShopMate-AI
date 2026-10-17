import { expect, it } from "vitest";
import { createSeed } from "../../../shared/domain/seed";
import { reviewState } from "../../../shared/domain/reviews";
import type { Review } from "./types";
it("keeps publication independent from writing eligibility and validates every purchase association", () => {
  const db = createSeed(),
    order = db.orders[0]!,
    line = order.items[0]!;
  const review: Review = {
    id: "r",
    userId: order.userId,
    orderId: order.id,
    orderItemId: line.id,
    productId: line.productId,
    rating: 5,
    content: "评价状态测试",
    createdAt: order.createdAt,
    hidden: false,
    deleted: false,
  };
  expect(reviewState(db.orders, review)).toBe("visible");
  // An open after-sale is deliberately not part of existing-review publication.
  line.quantity = 3;
  line.refundedQuantity = 1;
  expect(reviewState(db.orders, review)).toBe("visible");
  review.hidden = true;
  expect(reviewState(db.orders, review)).toBe("hidden");
  line.refundedQuantity = 3;
  expect(reviewState(db.orders, review)).toBe("refunded");
  review.deleted = true;
  expect(reviewState(db.orders, review)).toBe("deleted");
  review.deleted = false;
  for (const patch of [
    { userId: "other" },
    { productId: "other" },
    { orderItemId: "other" },
    { orderId: "other" },
  ])
    expect(reviewState(db.orders, { ...review, ...patch })).toBe("history");
});
