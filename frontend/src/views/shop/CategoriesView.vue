<script setup lang="ts">
import { useShop } from '../../stores/shop'
import { ArrowUpRight } from 'lucide-vue-next'
const shop = useShop()
</script>
<template>
  <div class="page-wrap">
    <div class="page-heading">
      <h1>按类挑选</h1>
      <p>从你熟悉的生活场景，找到下一件好物。</p>
    </div>
    <div class="category-gallery">
      <RouterLink
        v-for="c in [...shop.db.categories].sort((a, b) => a.sort - b.sort)"
        :key="c.id"
        :to="{ path: '/products', query: { category: c.id } }"
        ><img :src="c.image" :alt="c.name" />
        <div>
          <h2>{{ c.name }}</h2>
          <ArrowUpRight />
        </div>
        <p>{{ c.description }}</p>
        <span class="secondary"
          >{{
            shop.db.products.filter((p) => p.active && p.categoryId === c.id)
              .length
          }}
          件商品</span
        ></RouterLink
      >
    </div>
  </div>
</template>
