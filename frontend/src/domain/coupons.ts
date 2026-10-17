import type { Coupon } from "./types";
import { money } from "./types";
export const couponSoldOut = (coupon: Coupon) =>
  (coupon.claimedCount ?? 0) >= coupon.totalLimit;
export function couponUseReason(
  coupon: Coupon,
  subtotal: number | null,
  at: number,
) {
  if (!coupon.active) return "已停用，不能用于新订单";
  if (Date.parse(coupon.validFrom) > at) return "尚未开始使用";
  if (Date.parse(coupon.validUntil) <= at) return "已过使用期限";
  if (subtotal === null) return "请先确认有效商品金额";
  if (subtotal < coupon.threshold)
    return `未达门槛，还差 ${money(coupon.threshold - subtotal)}`;
  return "";
}
export function couponRules(coupon?: Coupon) {
  if (!coupon) return undefined;
  const value = { ...coupon };
  delete value.claimedCount;
  return value;
}
