<script setup lang="ts">
import type { OrderItem } from '../../domain/types'
import { money } from '../../domain/types'
defineProps<{ items: OrderItem[] }>()
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
      </div>
      <strong>{{ money(item.price * item.quantity) }}</strong>
    </div>
  </div>
</template>
