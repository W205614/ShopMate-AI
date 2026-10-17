import type { ShopApi } from "../../shared/domain/api";
import { reviewState } from "../../shared/domain/reviews";
import type {
  Database,
  PublicReviews,
  CouponInput,
} from "../../shared/domain/types";
import {
  admin,
  id,
  now,
  ownedOrder,
  requireThat,
  text,
  transact,
  userId,
  integer,
} from "./repository";

export const activeAfterSale = (status: string) =>
  !["cancelled", "rejected", "refunded"].includes(status);
export function reviewEligible(
  db: Database,
  review: Database["reviews"][number],
) {
  const order = db.orders.find(
    (o) => o.id === review.orderId && o.userId === review.userId,
  );
  const line = order?.items.find(
    (i) => i.id === review.orderItemId && i.productId === review.productId,
  );
  return !!line && line.refundedQuantity < line.quantity;
}
export function publicReviews(
  db: Database,
  productId: string,
  requestedPage = 1,
): PublicReviews {
  const visible = db.reviews
    .filter(
      (r) =>
        r.productId === productId && reviewState(db.orders, r) === "visible",
    )
    .sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
    );
  const pages = Math.max(1, Math.ceil(visible.length / 10));
  const page = Math.min(
    Number.isSafeInteger(requestedPage) && requestedPage > 0
      ? requestedPage
      : 1,
    pages,
  );
  return {
    total: visible.length,
    page,
    pages,
    averageRating: visible.length
      ? Math.round(
          (visible.reduce((n, r) => n + r.rating, 0) / visible.length) * 10,
        ) / 10
      : 0,
    items: visible.slice((page - 1) * 10, page * 10).map((r) => {
      const name = db.users.find((u) => u.id === r.userId)?.name ?? "用户";
      return {
        id: r.id,
        displayName: `${Array.from(name)[0] ?? "用"}**`,
        rating: r.rating,
        content: r.content,
        createdAt: r.createdAt,
      };
    }),
  };
}

export const marketingApi: Pick<
  ShopApi,
  | "saveCoupon"
  | "claimCoupon"
  | "toggleCoupon"
  | "submitReview"
  | "deleteReview"
  | "moderateReview"
> = {
  async saveCoupon(input) {
    await transact((db) => {
      admin();
      requireThat(
        text(input.name, 60) &&
          integer(input.threshold, 2) &&
          integer(input.discount, 1) &&
          input.discount < input.threshold &&
          integer(input.totalLimit, 1),
        "请填写有效券名称、满减金额和发行量，减免额须小于门槛",
      );
      const start = Date.parse(input.claimStartsAt),
        end = Date.parse(input.claimEndsAt),
        from = Date.parse(input.validFrom),
        until = Date.parse(input.validUntil);
      requireThat(
        [start, end, from, until].every(Number.isFinite) &&
          start < end &&
          from < until &&
          end <= until,
        "领取与使用时间范围无效，领取截止不能晚于使用截止",
      );
      const old = db.coupons.find((c) => c.id === input.id);
      const value: CouponInput = {
        id: input.id,
        name: input.name.trim(),
        threshold: input.threshold,
        discount: input.discount,
        totalLimit: input.totalLimit,
        active: input.active,
        claimStartsAt: input.claimStartsAt,
        claimEndsAt: input.claimEndsAt,
        validFrom: input.validFrom,
        validUntil: input.validUntil,
      };
      requireThat(!input.id || old, "优惠券不存在");
      if (old && db.couponClaims.some((c) => c.couponId === old.id)) {
        requireThat(
          (
            [
              "name",
              "threshold",
              "discount",
              "claimStartsAt",
              "claimEndsAt",
              "validFrom",
              "validUntil",
              "totalLimit",
            ] as const
          ).every((key) => old[key] === value[key]),
          "已有领取记录的优惠券只能启停，请新建其他优惠券",
        );
        old.active = input.active;
      } else if (old) Object.assign(old, value);
      else db.coupons.unshift({ ...value, id: id("coupon-") });
    });
  },
  async claimCoupon(couponId) {
    await transact((db) => {
      const uid = userId(),
        coupon = db.coupons.find((c) => c.id === couponId);
      const current = Date.now();
      requireThat(
        coupon &&
          coupon.active &&
          Date.parse(coupon.claimStartsAt) <= current &&
          current < Date.parse(coupon.claimEndsAt) &&
          current < Date.parse(coupon.validUntil),
        "优惠券不在可领取时间或已停用",
      );
      requireThat(
        !db.couponClaims.some(
          (c) => c.couponId === couponId && c.userId === uid,
        ),
        "每人每券限领一次",
      );
      requireThat(
        db.couponClaims.filter((c) => c.couponId === couponId).length <
          coupon.totalLimit,
        "优惠券已领完",
      );
      db.couponClaims.push({
        id: id("claim-"),
        userId: uid,
        couponId,
        claimedAt: now(),
        status: "available",
      });
    });
  },
  async toggleCoupon(couponId) {
    await transact((db) => {
      admin();
      const coupon = db.coupons.find((c) => c.id === couponId);
      requireThat(coupon, "优惠券不存在");
      coupon.active = !coupon.active;
    });
  },
  async submitReview(input) {
    await transact((db) => {
      const order = ownedOrder(db, input.orderId);
      const line = order.items.find((i) => i.id === input.orderItemId);
      requireThat(
        order.status === "completed" &&
          line &&
          line.refundedQuantity < line.quantity,
        "只有已收货且未全部退款的购买记录可以评价",
      );
      requireThat(
        !db.afterSales.some(
          (s) => s.orderId === order.id && activeAfterSale(s.status),
        ),
        "售后处理中暂不可评价",
      );
      requireThat(
        integer(input.rating, 1) &&
          input.rating <= 5 &&
          text(input.content, 1000) &&
          input.content.trim().length >= 5,
        "请填写1–5星评分和5–1000字评价",
      );
      requireThat(
        !db.reviews.some(
          (r) => r.orderId === order.id && r.orderItemId === line.id,
        ),
        "每个购买条目只能评价一次",
      );
      db.reviews.unshift({
        ...input,
        content: input.content.trim(),
        userId: userId(),
        id: id("review-"),
        productId: line.productId,
        createdAt: now(),
        hidden: false,
        deleted: false,
      });
    });
  },
  async deleteReview(reviewId) {
    await transact((db) => {
      const review = db.reviews.find(
        (r) => r.id === reviewId && r.userId === userId(),
      );
      requireThat(review, "评价不存在或不属于当前用户");
      review.deleted = true;
    });
  },
  async moderateReview(reviewId, hidden) {
    await transact((db) => {
      admin();
      const review = db.reviews.find((r) => r.id === reviewId);
      requireThat(review && !review.deleted, "评价不存在或已被用户删除");
      requireThat(typeof hidden === "boolean", "隐藏状态无效");
      requireThat(
        reviewEligible(db, review),
        "评价仅保留历史，不能恢复或隐藏公开展示",
      );
      review.hidden = hidden;
    });
  },
};
