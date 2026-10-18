<script setup lang="ts">
import CollectionPager from "../../components/shop/CollectionPager.vue";
import { computed } from "vue";
import { useShop } from "../../stores/shop";
import { api } from "../../services/api";
import { dateTime, money } from "../../domain/types";
import type { Coupon } from "../../domain/types";
import { couponSoldOut } from "../../domain/coupons";
import ActionNotice from "../../components/shop/ActionNotice.vue";
import { useAction } from "../../components/shop/useAction";
import "../../styles/account-commerce.css";

const shop = useShop();
const { busy, error, notice, run } = useAction();
const coupons = computed(() =>
  shop.db.coupons.filter(
    (coupon) => coupon.active && Date.parse(coupon.claimEndsAt) > Date.now(),
  ),
);
function claimed(id: string) {
  return shop.db.couponClaims.some(
    (c) => c.userId === shop.userId && c.couponId === id,
  );
}
function notStarted(coupon: Coupon) {
  return Date.parse(coupon.claimStartsAt) > Date.now();
}
async function claim(id: string) {
  await run(() => api.claimCoupon(id), "优惠券已领取，可在结算时选择使用");
}
</script>
<template>
  <div class="page-wrap">
    <div class="page-heading">
      <div>
        <h1>领券中心</h1>
        <p>为喜欢的好物，留一点优惠。</p>
      </div>
      <RouterLink
        v-if="shop.user"
        to="/account?section=coupons"
        class="text-link"
        >我的优惠券 ↗</RouterLink
      >
    </div>
    <ActionNotice :error="error" :notice="notice" />
    <div v-if="coupons.length" class="coupon-grid">
      <article
        v-for="coupon in coupons"
        :key="coupon.id"
        class="commerce-coupon"
      >
        <span class="commerce-badge">全店通用 · 满减券</span>
        <h2>{{ coupon.name }}</h2>
        <strong>{{ money(coupon.discount) }}</strong>
        <p>
          满 {{ money(coupon.threshold) }} 可用 · 每人限领一次 · 每单限用一张
        </p>
        <p class="secondary">
          领取时间：{{ dateTime(coupon.claimStartsAt) }} 至
          {{ dateTime(coupon.claimEndsAt) }}
        </p>
        <p class="secondary">
          使用时间：{{ dateTime(coupon.validFrom) }} 至
          {{ dateTime(coupon.validUntil) }}
        </p>
        <button
          v-if="shop.user || couponSoldOut(coupon)"
          class="button"
          :disabled="
            busy ||
            claimed(coupon.id) ||
            notStarted(coupon) ||
            couponSoldOut(coupon)
          "
          @click="claim(coupon.id)"
        >
          {{
            claimed(coupon.id)
              ? "已领取"
              : couponSoldOut(coupon)
                ? "已领完"
                : notStarted(coupon)
                  ? "尚未开始"
                  : "立即领取"
          }}
        </button>
        <RouterLink v-else to="/login?redirect=/coupons" class="button"
          >登录领取</RouterLink
        >
      </article>
    </div>
    <div v-else class="empty-state">
      <h2>暂时没有可领取的优惠券</h2>
      <p>新的优惠活动会在这里更新。</p>
      <RouterLink to="/products" class="button">去逛逛</RouterLink>
    </div>
    <CollectionPager />
  </div>
</template>
