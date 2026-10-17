<script setup lang="ts">
import { computed, ref } from "vue";
import { ArrowUpRight, ArrowRight } from "lucide-vue-next";
import { useShop } from "../../stores/shop";
import ProductCard from "../../components/shop/ProductCard.vue";
import {
  catalogueCategories,
  readCatalogueQuery,
  searchProducts,
} from "../../domain/catalogue";
const shop = useShop(),
  need = ref(""),
  submitted = ref(false),
  hovered = ref(""),
  selectedCategory = ref("");
const products = computed(() => shop.db.products.filter((p) => p.active));
const categories = computed(() =>
  catalogueCategories(shop.db.categories, shop.db.products),
);
const selected = computed(() =>
  categories.value.find((c) => c.id === selectedCategory.value),
);
const sheetProducts = computed(() =>
  selected.value
    ? products.value.filter((p) => p.categoryId === selected.value?.id)
    : products.value,
);
const picks = computed(() => {
  const q = need.value.trim().toLowerCase();
  if (!q) return products.value.filter((p) => p.featured).slice(0, 4);
  return searchProducts(
    products.value,
    shop.db.categories,
    readCatalogueQuery({ q }),
  ).slice(0, 4);
});
const preview = computed(() =>
  products.value.find((p) => p.id === hovered.value),
);
</script>
<template>
  <div class="home">
    <section class="catalogue-intro">
      <div class="home-title">
        <div class="home-intro-copy">
          <h1>{{ shop.db.settings.slogan.replace(/。$/, "") }}</h1>
          <p>日常所需，认真挑选。数码、家居、穿搭与更多。</p>
        </div>
        <RouterLink to="/support" class="home-help"
          >选购有疑问？<span>问购物伙伴 <ArrowUpRight :size="18" /></span
        ></RouterLink>
      </div>
      <nav class="home-departments" aria-label="首页快捷分类">
        <button
          type="button"
          :aria-pressed="!selected"
          :class="{ selected: !selected }"
          @click="
            selectedCategory = '';
            hovered = '';
          "
        >
          全部商品 <span>{{ products.length }}</span>
        </button>
        <button
          v-for="category in categories"
          :key="category.id"
          type="button"
          :aria-pressed="selected?.id === category.id"
          :class="{ selected: selected?.id === category.id }"
          @click="
            selectedCategory = category.id;
            hovered = '';
          "
        >
          {{ category.name }} <span>{{ category.count }}</span>
        </button>
      </nav>
      <p class="catalogue-demo">{{ shop.db.settings.notice }}</p>
      <div class="sheet-heading">
        <span>
          {{ selected ? selected.name : "一眼看完，慢慢挑选" }}
          <small class="sheet-preview">{{
            preview?.subtitle ??
            `${sheetProducts.length} 款演示商品 · ${selected ? selected.description : `${categories.length} 种日常生活`}`
          }}</small></span
        >
        <RouterLink
          :to="{
            path: '/products',
            query: selected ? { category: selected.id } : {},
          }"
          class="button home-primary"
          >查看{{ selected ? selected.name : "全部商品" }}
          <ArrowUpRight :size="18"
        /></RouterLink>
      </div>
      <p v-if="!sheetProducts.length" class="empty-inline" role="status">
        这个分类暂时没有上架商品，试试其他分类。
      </p>
      <div v-else class="contact-sheet" @mouseleave="hovered = ''">
        <RouterLink
          v-for="(p, i) in sheetProducts"
          :key="p.id"
          :to="`/products/${p.id}`"
          class="sheet-frame"
          :class="{ 'sheet-dim': hovered && hovered !== p.id }"
          :style="{ '--item-delay': `${i * 65}ms` }"
          @mouseenter="hovered = p.id"
          @focus="hovered = p.id"
          ><img
            :src="p.images[0]"
            :alt="p.name"
            :loading="i < 8 ? 'eager' : 'lazy'"
          /><span>{{ p.name }}</span></RouterLink
        >
      </div>
    </section>
    <section class="home-categories">
      <div class="section-heading">
        <h2>从喜欢的生活开始</h2>
        <RouterLink to="/categories"
          >全部分类 <ArrowRight :size="18"
        /></RouterLink>
      </div>
      <div class="category-index">
        <RouterLink
          v-for="c in categories"
          :key="c.id"
          :to="{ path: '/products', query: { category: c.id } }"
          ><span>{{ c.name }}</span
          ><span>{{ c.description }} · {{ c.count }} 件商品</span
          ><ArrowUpRight :size="25"
        /></RouterLink>
      </div>
    </section>
    <section class="shopping-partner">
      <div>
        <h2>告诉我，<br />你想找什么。</h2>
        <p>
          试试“耳机”“家居”或“运动”。根据商品名称与说明匹配，为你缩小选择范围。
        </p>
        <p class="secondary">规则推荐演示 · 未连接大模型</p>
      </div>
      <div class="partner-content">
        <form @submit.prevent="submitted = true" class="need-form">
          <label for="need">你的购物需求</label>
          <div>
            <input
              id="need"
              v-model="need"
              placeholder="比如：通勤 耳机"
              @input="submitted = false"
            /><button class="button" type="submit">
              查看推荐 <ArrowUpRight :size="18" />
            </button>
          </div>
        </form>
        <div v-if="picks.length" class="mini-products">
          <ProductCard v-for="p in picks" :key="p.id" :product="p" compact />
        </div>
        <div v-else class="empty-inline">
          <p>暂时没找到匹配商品。试试更短的关键词，或让客服帮你找。</p>
          <RouterLink to="/support">咨询购物伙伴</RouterLink>
        </div>
        <p v-if="submitted && picks.length" role="status" class="secondary">
          找到 {{ picks.length }} 件匹配商品，点击查看规格与库存。
        </p>
      </div>
    </section>
    <section class="home-featured">
      <div class="section-heading">
        <h2>值得多看一眼</h2>
        <RouterLink to="/products"
          >继续逛逛 <ArrowRight :size="18"
        /></RouterLink>
      </div>
      <div class="product-grid">
        <ProductCard
          v-for="p in products.filter((p) => p.featured).slice(0, 4)"
          :key="p.id"
          :product="p"
        />
      </div>
    </section>
    <section class="service-close">
      <p>商品怎么选，订单到哪里，<br />售后怎么办。</p>
      <div>
        <h2>每个问题，都有入口。</h2>
        <p>咨询时带上商品或订单，购物伙伴会接着你的问题往下聊。</p>
        <RouterLink to="/support" class="button"
          >打开客服中心 <ArrowUpRight :size="18"
        /></RouterLink>
      </div>
    </section>
  </div>
</template>
