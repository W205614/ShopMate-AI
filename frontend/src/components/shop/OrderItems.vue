<script setup lang="ts">
import type { OrderItem } from "../../domain/types";
import { money } from "../../domain/types";
defineProps<{ items: OrderItem[] }>();
</script>
<template>
  <div class="order-items">
    <div
      v-for="(item, i) in items"
      :key="`${item.skuId}-${i}`"
      class="order-item"
    >
      <RouterLink :to="`/products/${item.productId}`"
        ><img :src="item.image" :alt="item.name"
      /></RouterLink>
      <div>
        <RouterLink :to="`/products/${item.productId}`">{{
          item.name
        }}</RouterLink>
        <p class="secondary">{{ item.skuName }} · {{ item.quantity }} 件</p>
        <p v-if="item.discount" class="secondary">
          原金额 {{ money(item.price * item.quantity) }} · 优惠
          {{ money(item.discount) }}
        </p>
        <p v-if="item.refundedQuantity" class="secondary">
          已退款 {{ item.refundedQuantity }} 件 · 剩余履约
          {{ item.quantity - item.refundedQuantity }} 件
        </p>
      </div>
      <strong>{{ money(item.total) }}</strong>
    </div>
  </div>
</template>
