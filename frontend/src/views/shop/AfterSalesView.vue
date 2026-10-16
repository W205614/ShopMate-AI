<script setup lang="ts">
import { computed } from 'vue'
import { useShop } from '../../stores/shop'
import { afterSaleLabels, dateTime, money } from '../../domain/types'
const shop = useShop(),
  records = computed(() =>
    [...shop.db.afterSales]
      .filter((a) => a.userId === shop.userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  )
</script>
<template>
  <div class="page-wrap">
    <div class="page-heading">
      <h1>售后服务</h1>
      <p>每一笔申请，都可以在这里查看进度。</p>
    </div>
    <div class="after-sale-explainer">
      <h2>需要帮助？</h2>
      <p>
        从订单详情发起售后。未发货订单审核后退款；已发货订单按退货流程处理，管理端确认收货后退款。
      </p>
      <RouterLink to="/orders" class="text-link">选择需要售后的订单</RouterLink>
    </div>
    <div v-if="records.length" class="orders-list">
      <article v-for="a in records" :key="a.id" class="order-block">
        <div class="order-top">
          <div>
            <strong>{{ a.reason }}</strong
            ><span class="secondary">{{ dateTime(a.createdAt) }}</span>
          </div>
          <strong class="order-status">{{ afterSaleLabels[a.status] }}</strong>
        </div>
        <p>{{ a.description }}</p>
        <p class="secondary">
          {{ a.requiresReturn ? '退货退款' : '仅退款' }} · 订单
          {{ a.orderId }} ·
          {{ money(shop.myOrders.find((o) => o.id === a.orderId)?.total ?? 0) }}
        </p>
        <p v-if="a.note">处理说明：{{ a.note }}</p>
        <p
          v-if="a.status === 'approved' && a.requiresReturn"
          class="action-notice"
        >
          退货申请已批准。此为模拟流程，可在管理端确认退货收货后继续退款，无需实际寄件。
        </p>
        <div class="button-row">
          <RouterLink
            :to="`/orders/${a.orderId}`"
            class="button secondary-button"
            >查看订单</RouterLink
          ><RouterLink
            :to="{ path: '/support', query: { orderId: a.orderId } }"
            class="text-link"
            >咨询进度</RouterLink
          >
        </div>
      </article>
    </div>
    <div v-else class="empty-state">
      <h2>暂无售后记录</h2>
      <p>需要退货或退款时，从对应订单发起申请。</p>
      <RouterLink to="/orders" class="button">查看我的订单</RouterLink>
    </div>
  </div>
</template>
