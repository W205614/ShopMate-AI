<script setup lang="ts">
import { computed, ref, onUnmounted } from "vue";
import { useRoute } from "vue-router";
import { useShop } from "../../stores/shop";
import { api } from "../../services/api";
import { money, dateTime } from "../../domain/types";
import { Check, ShieldCheck, RotateCcw, X } from "lucide-vue-next";
import ActionNotice from "../../components/shop/ActionNotice.vue";
import { useAction } from "../../components/shop/useAction";
const route = useRoute(),
  shop = useShop(),
  { busy, pending, error, notice, run } = useAction(),
  order = computed(() => shop.myOrders.find((o) => o.id === route.params.id));
const now = ref(Date.now()),
  timer = window.setInterval(() => {
    now.value = Date.now();
  }, 1000);
onUnmounted(() => window.clearInterval(timer));
const remaining = computed(() =>
  Math.max(
    0,
    Math.ceil((Date.parse(order.value?.expiresAt ?? "") - now.value) / 1000),
  ),
);
const expired = computed(
  () => !!order.value?.expiresAt && remaining.value <= 0,
);
const title = computed(() => {
  if (order.value?.status === "refunded") return "订单已退款";
  if (order.value?.status === "cancelled") return "订单已取消";
  if (order.value?.status === "pending") return "模拟支付";
  return "模拟支付成功";
});
async function pay() {
  if (order.value) await run(() => api.payOrder(order.value!.id));
}
</script>
<template>
  <div class="page-wrap payment-page">
    <template v-if="order"
      ><div class="payment-icon">
        <RotateCcw v-if="order.status === 'refunded'" :size="32" />
        <X v-else-if="order.status === 'cancelled'" :size="32" />
        <ShieldCheck v-else-if="order.status === 'pending'" :size="32" />
        <Check v-else :size="32" />
      </div>
      <h1>
        {{ title }}
      </h1>
      <p>订单号 {{ order.id }}</p>
      <p class="payment-amount">{{ money(order.total) }}</p>
      <p class="payment-explanation">
        这是服务端模拟交易，不会扣款，也不会收集银行卡或支付密码。
      </p>
      <p v-if="order.status === 'pending' && order.expiresAt" class="secondary">
        付款截止 {{ dateTime(order.expiresAt) }} ·
        {{
          expired
            ? "已超时，请返回订单查看关闭状态"
            : `剩余 ${Math.floor(remaining / 60)} 分 ${remaining % 60} 秒`
        }}
      </p>
      <ActionNotice :error="error" :notice="notice" />
      <div v-if="order.status === 'pending'" class="payment-actions">
        <button class="button" :disabled="busy || expired" @click="pay">
          {{ pending ? "处理中…" : "确认模拟支付" }}</button
        ><RouterLink :to="`/orders/${order.id}`" class="text-link"
          >暂不支付，返回订单</RouterLink
        >
      </div>
      <div v-else class="payment-actions">
        <RouterLink :to="`/orders/${order.id}`" class="button"
          >查看订单</RouterLink
        ><RouterLink to="/products" class="text-link">继续逛逛</RouterLink>
      </div>
      <p v-if="order.status === 'paid'" class="secondary">
        已记录收款并扣减库存。可在管理端模拟发货。
      </p></template
    >
    <div v-else class="empty-state">
      <h1>没有找到该订单</h1>
      <RouterLink to="/orders" class="button">查看我的订单</RouterLink>
    </div>
  </div>
</template>
