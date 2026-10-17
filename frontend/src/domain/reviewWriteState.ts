import type { Order, OrderItem, Review, AfterSale } from "./types";
// This is presentation guidance; the server authoritatively rechecks submission.
export function reviewWriteReason(
  order: Order | undefined,
  item: OrderItem | undefined,
  reviews: Review[],
  afterSales: AfterSale[],
) {
  if (
    !order ||
    !item ||
    !order.items.some((i) => i.id === item.id && i.productId === item.productId)
  )
    return "未找到可访问的购买记录";
  if (
    reviews.some(
      (r) =>
        r.userId === order.userId &&
        r.orderId === order.id &&
        r.orderItemId === item.id,
    )
  )
    return "已评价，不能重复评价";
  if (item.refundedQuantity >= item.quantity)
    return "该商品已全部退款，不能评价";
  if (order.status === "cancelled") return "订单已取消，不能评价";
  if (order.status !== "completed") return "确认收货后可评价";
  if (
    afterSales.some(
      (a) =>
        a.orderId === order.id &&
        a.userId === order.userId &&
        ["requested", "approved", "returning", "received"].includes(a.status),
    )
  )
    return "售后处理中，暂不可评价";
  return "";
}
