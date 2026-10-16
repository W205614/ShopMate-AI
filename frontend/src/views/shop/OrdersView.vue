<script setup lang="ts">
import { computed, ref } from 'vue'
import { useShop } from '../../stores/shop'
import { api } from '../../services/api'
import { money, dateTime, orderLabels } from '../../domain/types'
import type { OrderStatus } from '../../domain/types'
import OrderItems from '../../components/shop/OrderItems.vue'
import ActionNotice from '../../components/shop/ActionNotice.vue'
import { useAction } from '../../components/shop/useAction'
const shop = useShop(),
  filter = ref('all'),
  { busy, error, notice, run } = useAction(),
  orders = computed(() =>
    [...shop.myOrders]
      .filter((o) => filter.value === 'all' || o.status === filter.value)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  )
const statuses: OrderStatus[] = [
  'pending',
  'paid',
  'shipped',
  'completed',
  'cancelled',
  'refunded',
]
function confirm(id: string) {
  return run(() => api.confirmOrder(id), '已确认收货')
}
async function cancel(id: string) {
  if (window.confirm('确认取消这笔待付款订单？'))
    await run(() => api.cancelOrder(id), '订单已取消')
}
</script>
<template>
  <div class="page-wrap">
    <div class="page-heading">
      <h1>我的订单</h1>
      <p>从付款到收货，每一步都在这里。</p>
    </div>
    <div class="tabs" role="group" aria-label="订单状态筛选">
      <button :class="{ selected: filter === 'all' }" @click="filter = 'all'">
        全部</button
      ><button
        v-for="s in statuses"
        :key="s"
        :class="{ selected: filter === s }"
        @click="filter = s"
      >
        {{ orderLabels[s] }}
      </button>
    </div>
    <ActionNotice :error="error" :notice="notice" />
    <div v-if="orders.length" class="orders-list">
      <article v-for="o in orders" :key="o.id" class="order-block" data-ui>
        <div class="order-top">
          <div>
            <RouterLink :to="`/orders/${o.id}`">{{ o.id }}</RouterLink
            ><span class="secondary">{{ dateTime(o.createdAt) }}</span>
          </div>
          <strong class="order-status">{{ orderLabels[o.status] }}</strong>
        </div>
        <OrderItems :items="o.items" />
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
              :disabled="busy"
              @click="confirm(o.id)"
            >
              确认收货</button
            ><RouterLink :to="`/orders/${o.id}`" class="button secondary-button"
              >订单详情</RouterLink
            >
          </div>
        </div>
      </article>
    </div>
    <div v-else class="empty-state">
      <h2>这里还没有订单</h2>
      <p>
        {{
          filter === 'all'
            ? '挑选喜欢的商品，开始一次演示购物。'
            : '当前状态下没有订单，试试查看全部。'
        }}
      </p>
      <RouterLink to="/products" class="button">去逛逛</RouterLink>
    </div>
  </div>
</template>
