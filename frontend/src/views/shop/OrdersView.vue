<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useShop } from "../../stores/shop";
import { api } from "../../services/api";
import { money, dateTime, orderLabels } from "../../domain/types";
import type { OrderStatus } from "../../domain/types";
import OrderItems from "../../components/shop/OrderItems.vue";
import ActionNotice from "../../components/shop/ActionNotice.vue";
import { useAction } from "../../components/shop/useAction";
import "../../styles/commerce-flow.css";
const shop = useShop(),
  route = useRoute(),
  router = useRouter(),
  search = ref(String(route.query.q ?? "")),
  filter = computed(() => String(route.query.status ?? "all")),
  { busy, error, notice, run } = useAction(),
  orders = computed(() =>
    [...shop.myOrders]
      .filter(
        (o) =>
          (filter.value === "all" || o.status === filter.value) &&
          `${o.id} ${o.items.map((i) => i.name).join(" ")}`
            .toLocaleLowerCase()
            .includes(
              String(route.query.q ?? "")
                .trim()
                .toLocaleLowerCase(),
            ),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  );
const pages = computed(() => Math.max(1, Math.ceil(orders.value.length / 10)));
const pageNumber = computed(() =>
  Math.min(pages.value, Math.max(1, Math.floor(Number(route.query.page) || 1))),
);
const visibleOrders = computed(() =>
  orders.value.slice((pageNumber.value - 1) * 10, pageNumber.value * 10),
);
watch(
  () => route.query.q,
  (value) => {
    search.value = String(value ?? "");
  },
);
function navigate(status = filter.value, page = 1) {
  router.push({
    path: "/orders",
    query: {
      ...(search.value.trim() ? { q: search.value.trim() } : {}),
      ...(status !== "all" ? { status } : {}),
      ...(page > 1 ? { page: String(page) } : {}),
    },
  });
}
const statuses: OrderStatus[] = [
  "pending",
  "paid",
  "shipped",
  "completed",
  "cancelled",
  "refunded",
];
function confirm(id: string) {
  return run(() => api.confirmOrder(id), "已确认收货");
}
function activeAfterSale(id: string) {
  return shop.db.afterSales.some(
    (a) =>
      a.orderId === id &&
      ["requested", "approved", "returning", "received"].includes(a.status),
  );
}
async function reorder(id: string) {
  let message = "";
  if (
    await run(async () => {
      const result = await api.reorder(id);
      message = `已加入 ${result.added} 件${result.skipped.length ? `；无法加入：${result.skipped.join("、")}` : "，可到购物车确认最新价格和库存。"}`;
    })
  )
    notice.value = message;
}
async function cancel(id: string) {
  if (window.confirm("确认取消这笔待付款订单？"))
    await run(() => api.cancelOrder(id), "订单已取消");
}
</script>
<template>
  <div class="page-wrap">
    <div class="page-heading">
      <h1>我的订单</h1>
      <p>从付款到收货，每一步都在这里。</p>
    </div>
    <div class="tabs" role="group" aria-label="订单状态筛选">
      <button :class="{ selected: filter === 'all' }" @click="navigate('all')">
        全部</button
      ><button
        v-for="s in statuses"
        :key="s"
        :class="{ selected: filter === s }"
        @click="navigate(s)"
      >
        {{ orderLabels[s] }}
      </button>
    </div>
    <form class="commerce-toolbar" role="search" @submit.prevent="navigate()">
      <input
        v-model="search"
        aria-label="订单号或商品名称"
        placeholder="搜索订单号或商品名称"
        maxlength="100"
      /><button class="button">搜索订单</button
      ><span class="secondary">共 {{ orders.length }} 笔订单</span>
    </form>
    <ActionNotice :error="error" :notice="notice" />
    <div v-if="orders.length" class="orders-list">
      <article
        v-for="o in visibleOrders"
        :key="o.id"
        class="order-block"
        data-ui
      >
        <div class="order-top">
          <div>
            <RouterLink :to="`/orders/${o.id}`">{{ o.id }}</RouterLink
            ><span class="secondary">{{ dateTime(o.createdAt) }}</span>
          </div>
          <strong class="order-status">{{ orderLabels[o.status] }}</strong>
        </div>
        <OrderItems :items="o.items" />
        <p v-if="o.refundedAmount" class="commerce-amount-note">
          已退款 {{ money(o.refundedAmount) }}
        </p>
        <p v-if="o.status === 'pending' && o.expiresAt" class="secondary">
          付款截止 {{ dateTime(o.expiresAt) }}
        </p>
        <div class="order-bottom">
          <span
            >共 {{ o.items.reduce((n, i) => n + i.quantity, 0) }} 件
            <strong>{{ money(o.total) }}</strong></span
          >
          <div class="button-row">
            <button
              v-if="o.status === 'pending'"
              :disabled="busy"
              @click="cancel(o.id)"
            >
              取消订单</button
            ><RouterLink
              v-if="o.status === 'pending'"
              :to="`/orders/${o.id}/pay`"
              class="button"
              >模拟支付</RouterLink
            ><button
              v-if="o.status === 'shipped'"
              class="button"
              :disabled="busy || activeAfterSale(o.id)"
              @click="confirm(o.id)"
            >
              确认收货</button
            ><RouterLink :to="`/orders/${o.id}`" class="button secondary-button"
              >订单详情</RouterLink
            >
          </div>
          <button :disabled="busy" @click="reorder(o.id)">再次购买</button>
        </div>
      </article>
      <nav v-if="pages > 1" class="commerce-pagination" aria-label="订单分页">
        <button
          :disabled="pageNumber <= 1"
          @click="navigate(filter, pageNumber - 1)"
        >
          上一页</button
        ><span>第 {{ pageNumber }} / {{ pages }} 页</span
        ><button
          :disabled="pageNumber >= pages"
          @click="navigate(filter, pageNumber + 1)"
        >
          下一页
        </button>
      </nav>
    </div>
    <div v-else class="empty-state">
      <h2>这里还没有订单</h2>
      <p>
        {{
          filter === "all"
            ? "挑选喜欢的商品，开始一次演示购物。"
            : "当前状态下没有订单，试试查看全部。"
        }}
      </p>
      <RouterLink to="/products" class="button">去逛逛</RouterLink>
    </div>
  </div>
</template>
