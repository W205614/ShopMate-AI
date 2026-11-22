<script setup lang="ts">
import type { Product } from "../../domain/types";
import { money } from "../../domain/types";
import { computed } from "vue";
import { productPrice } from "../../domain/catalogue";
const props = defineProps<{ product: Product; compact?: boolean }>();
const matchedSku = computed(() =>
  props.product.skus.find((sku) => sku.id === props.product.matchedSkuId),
);
</script>
<template>
  <RouterLink
    :to="{
      path: `/products/${product.id}`,
      query: matchedSku ? { sku: matchedSku.id } : {},
    }"
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
      <span>{{ money(productPrice(product)) }}</span>
    </div>
    <p v-if="matchedSku">
      规格：{{ matchedSku.name }}<span v-if="!matchedSku.stock"> · 已售罄</span>
    </p>
    <p v-if="!compact">{{ product.subtitle }}</p></RouterLink
  >
</template>
