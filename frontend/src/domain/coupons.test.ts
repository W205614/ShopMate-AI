import { expect, it } from "vitest";
import type { Coupon } from "./types";
import { couponRules, couponSoldOut, couponUseReason } from "./coupons";
const coupon: Coupon = {
  id: "c",
  name: "满减券",
  threshold: 100,
  discount: 1,
  totalLimit: 1,
  claimedCount: 1,
  active: true,
  claimStartsAt: "2026-10-01T00:00:00Z",
  claimEndsAt: "2026-11-01T00:00:00Z",
  validFrom: "2026-10-01T00:00:00Z",
  validUntil: "2026-11-01T00:00:00Z",
};
const at = Date.parse("2026-10-17T00:00:00Z");
it("已领完只影响领取，不影响已领券使用，门槛边界精确到分", () => {
  expect(couponSoldOut(coupon)).toBe(true);
  expect(couponUseReason(coupon, 99, at)).toBe("未达门槛，还差 ¥0.01");
  expect(couponUseReason(coupon, 100, at)).toBe("");
  expect(couponUseReason(coupon, null, at)).toContain("请先确认");
  expect(couponUseReason({ ...coupon, active: false }, 100, at)).toContain(
    "已停用",
  );
  expect(couponUseReason(coupon, 100, Date.parse(coupon.validUntil))).toContain(
    "已过使用期限",
  );
});
it("展示聚合变化不改变报价规则快照，真实优惠变化仍被识别", () => {
  const before = JSON.stringify(couponRules(coupon));
  expect(JSON.stringify(couponRules({ ...coupon, claimedCount: 2 }))).toBe(
    before,
  );
  expect(JSON.stringify(couponRules({ ...coupon, discount: 2 }))).not.toBe(
    before,
  );
  expect(coupon.claimedCount).toBe(1);
});
