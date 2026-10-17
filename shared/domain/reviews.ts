import type { Order, Review } from "./types";
export const reviewLabels = {
  visible: "已发布",
  hidden: "已隐藏",
  refunded: "已全退，仅保留历史",
  history: "关联购买记录不可用，仅保留历史",
  deleted: "用户已删除",
};
// Publication is independent from eligibility to write a new review. An open
// after-sale does not remove an existing review until its line is fully refunded.
export function reviewState(
  orders: Order[],
  review: Review,
): keyof typeof reviewLabels {
  if (review.deleted) return "deleted";
  const order = orders.find(
    (o) => o.id === review.orderId && o.userId === review.userId,
  );
  const line = order?.items.find(
    (i) => i.id === review.orderItemId && i.productId === review.productId,
  );
  if (!line) return "history";
  if (line.refundedQuantity >= line.quantity) return "refunded";
  return review.hidden ? "hidden" : "visible";
}
