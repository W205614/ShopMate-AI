<script setup lang="ts">
import type { Product } from '../../domain/types'
import { money } from '../../domain/types'
defineProps<{ product: Product; compact?: boolean }>()
</script>
<template>
  <RouterLink
    :to="`/products/${product.id}`"
    class="product-card"
    :class="{ 'is-compact': compact }"
    ><div class="product-photo">
      <img :src="product.images[0]" :alt="product.name" loading="lazy" /><span
        v-if="!product.skus.some((s) => s.stock > 0)"
        class="stock-note"
        >暂时售罄</span
      >
    </div>
    <div class="product-caption">
      <h3>{{ product.name }}</h3>
      <span>{{ money(Math.min(...product.skus.map((s) => s.price))) }}</span>
    </div>
    <p v-if="!compact">{{ product.subtitle }}</p></RouterLink
  >
</template>
