<script setup lang="ts">
import CollectionPager from "../../components/shop/CollectionPager.vue";
import { computed } from "vue";
import { catalogueCategories } from "../../domain/catalogue";
import { useShop } from "../../stores/shop";
import { ArrowUpRight } from "lucide-vue-next";
const shop = useShop();
const categories = computed(() =>
  catalogueCategories(shop.db.categories, shop.db.products),
);
</script>
<template>
  <div class="page-wrap">
    <div class="page-heading">
      <h1>按类挑选</h1>
      <p>从你熟悉的生活场景，找到下一件好物。</p>
    </div>
    <p v-if="!categories.length" class="empty-state">
      暂时没有商品分类，请稍后再来。
    </p>
    <div v-else class="category-gallery">
      <RouterLink
        v-for="c in categories"
        :key="c.id"
        :to="{ path: '/products', query: { category: c.id } }"
        ><img :src="c.image" :alt="c.name" />
        <div>
          <h2>{{ c.name }}</h2>
          <ArrowUpRight />
        </div>
        <p>{{ c.description }}</p>
        <span class="secondary">{{ c.count }} 件商品</span></RouterLink
      >
    </div>
    <CollectionPager />
  </div>
</template>
