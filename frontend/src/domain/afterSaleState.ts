import type { AfterSale, Order } from "./types";
// Shared guidance only; the API independently validates ownership and transitions.
export function afterSaleState(sale: AfterSale, order?: Order) {
  const orderMatches =
    !!order && order.id === sale.orderId && order.userId === sale.userId;
  const canCancel =
    ["requested", "approved"].includes(sale.status) && !sale.returnTracking;
  const canReturn = sale.status === "approved" && sale.requiresReturn;
  const canApprove = sale.status === "requested" && orderMatches;
  const canReceive =
    orderMatches &&
    sale.status === "returning" &&
    sale.requiresReturn &&
    !!sale.returnCarrier?.trim() &&
    !!sale.returnTracking?.trim();
  const refundStage =
    sale.status === "received" ||
    (sale.status === "approved" && !sale.requiresReturn);
  const canRefund =
    refundStage &&
    orderMatches &&
    ["paid", "shipped", "completed"].includes(order?.status ?? "");
  let guidance = {
    requested: "等待管理员审核，提交退货单号前可以撤销申请。",
    approved: sale.requiresReturn
      ? "退货申请已批准。请填写模拟承运商与单号，管理员确认收货后退款，无需实际寄件。"
      : "申请已批准，等待管理员执行模拟退款。",
    returning: "退货运输中，等待管理员确认收到退货。",
    received: "已确认收到退货，等待管理员执行模拟退款。",
    refunded: "本次退款已完成，可在订单中核对剩余商品。",
    rejected: "申请已拒绝，请查看处理说明，剩余可退商品可以重新申请。",
    cancelled: "申请已撤销，剩余可退商品可以重新申请。",
  }[sale.status];
  if (
    sale.status === "returning" &&
    (!sale.returnCarrier?.trim() || !sale.returnTracking?.trim())
  )
    guidance = "退货物流信息不完整，核对承运商与单号后才能确认收货。";
  if (refundStage && !canRefund)
    guidance = "关联订单当前不可退款，请联系人工客服核对订单状态。";
  if (
    !orderMatches &&
    ["requested", "approved", "returning", "received"].includes(sale.status)
  )
    guidance = "关联订单数据不可用，请联系人工客服核对后再处理。";
  return {
    canCancel,
    canReturn,
    canApprove,
    canReject: canApprove,
    canReceive,
    canRefund,
    guidance,
  };
}
