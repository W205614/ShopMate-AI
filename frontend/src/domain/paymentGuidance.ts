import type { CustomerPaymentState } from "../../../shared/domain/production";

export function paymentStatusText(payment: CustomerPaymentState) {
  if (
    payment.closeRequested &&
    ["creating", "pending", "unknown"].includes(payment.status)
  )
    return "正在确认关单";
  return {
    creating: "正在创建支付单",
    pending: "等待渠道确认付款",
    unknown: "支付结果待核对，请勿重复付款",
    succeeded: "付款已确认",
    closed: "支付单已关闭",
    failed: "支付未受理，可重新选择渠道",
  }[payment.status];
}

export function paymentNeedsHelp(payment?: CustomerPaymentState | null) {
  return (
    payment?.status === "unknown" ||
    (payment?.status === "pending" &&
      Date.now() - Date.parse(payment.createdAt) >= 120_000)
  );
}
