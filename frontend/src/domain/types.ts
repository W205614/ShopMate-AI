export * from "../../../shared/domain/types";

export function cancellationNotice(status?: "closing" | "cancelled") {
  if (status === "closing") return "取消申请已提交，正在确认渠道关单结果。";
  if (status === "cancelled") return "订单已取消";
  return "取消请求已处理，请核对订单状态。";
}
