import { expect, it } from "vitest";
import { createSeed } from "../../../shared/domain/seed";
import type { AfterSale, Review } from "./types";
import { reviewWriteReason } from "./reviewWriteState";
it("uses write eligibility independently from public visibility and keeps permanent reasons first", () => {
  const order = createSeed().orders[0]!,
    item = order.items[0]!;
  const review = {
    id: "review",
    userId: order.userId,
    orderId: order.id,
    orderItemId: item.id,
    productId: item.productId,
    rating: 5,
    content: "测试评价内容",
    hidden: true,
    deleted: true,
    createdAt: new Date().toISOString(),
  } satisfies Review;
  const sale = {
    orderId: order.id,
    userId: order.userId,
    status: "requested",
  } as AfterSale;
  expect(reviewWriteReason(order, item, [], [])).toBe("");
  expect(reviewWriteReason(undefined, item, [], [])).toBe(
    "未找到可访问的购买记录",
  );
  expect(reviewWriteReason(order, item, [], [sale])).toBe(
    "售后处理中，暂不可评价",
  );
  expect(
    reviewWriteReason(order, item, [], [{ ...sale, status: "cancelled" }]),
  ).toBe("");
  expect(reviewWriteReason(order, item, [review], [sale])).toBe(
    "已评价，不能重复评价",
  );
  item.quantity = 2;
  item.refundedQuantity = 1;
  expect(reviewWriteReason(order, item, [], [])).toBe("");
  item.refundedQuantity = item.quantity;
  expect(reviewWriteReason(order, item, [], [sale])).toBe(
    "该商品已全部退款，不能评价",
  );
  expect(reviewWriteReason(order, item, [review], [sale])).toBe(
    "已评价，不能重复评价",
  );
  item.refundedQuantity = 0;
  order.status = "shipped";
  expect(reviewWriteReason(order, item, [], [])).toBe("确认收货后可评价");
  order.status = "cancelled";
  expect(reviewWriteReason(order, item, [], [])).toBe("订单已取消，不能评价");
});
