import { orderLabels, type Order } from "../../../shared/domain/types";
export * from "../../../shared/domain/types";

export function orderStatusLabel(
  order: Pick<Order, "status" | "cancelRequested" | "parcels">,
) {
  if (order.status === "paid" && order.parcels?.length) return "部分已发货";
  return order.status === "pending" && order.cancelRequested
    ? "正在确认关单"
    : orderLabels[order.status];
}

export function cancellationNotice(status?: "closing" | "cancelled") {
  if (status === "closing") return "取消申请已提交，正在确认渠道关单结果。";
  if (status === "cancelled") return "订单已取消";
  return "取消请求已处理，请核对订单状态。";
}
