<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Search } from 'lucide-vue-next'
import { useShop } from '../../stores/shop'
import ProductCard from '../../components/shop/ProductCard.vue'
const shop = useShop(),
  route = useRoute(),
  router = useRouter(),
  q = ref(String(route.query.q ?? '')),
  min = ref(String(route.query.min ?? '')),
  max = ref(String(route.query.max ?? ''))
const category = computed(() => String(route.query.category ?? '')),
  sort = computed(() => String(route.query.sort ?? 'featured')),
  page = computed(() => Math.max(1, Number(route.query.page) || 1))
watch(
  () => route.query,
  () => {
    q.value = String(route.query.q ?? '')
    min.value = String(route.query.min ?? '')
    max.value = String(route.query.max ?? '')
  },
)
const filtered = computed(() => {
  let list = shop.db.products.filter((p) => p.active)
  const query = String(route.query.q ?? '')
    .trim()
    .toLowerCase()
  if (query)
    list = list.filter((p) =>
      `${p.name}${p.subtitle}${p.description}`.toLowerCase().includes(query),
    )
  if (category.value) list = list.filter((p) => p.categoryId === category.value)
  if (route.query.min)
    list = list.filter(
      (p) =>
        Math.min(...p.skus.map((s) => s.price)) >=
        Number(route.query.min) * 100,
    )
  if (route.query.max)
    list = list.filter(
      (p) =>
        Math.min(...p.skus.map((s) => s.price)) <=
        Number(route.query.max) * 100,
    )
  return [...list].sort((a, b) =>
    sort.value === 'price-asc'
      ? Math.min(...a.skus.map((s) => s.price)) -
        Math.min(...b.skus.map((s) => s.price))
      : sort.value === 'price-desc'
        ? Math.min(...b.skus.map((s) => s.price)) -
          Math.min(...a.skus.map((s) => s.price))
        : Number(b.featured) - Number(a.featured),
  )
})
const pages = computed(() =>
    Math.max(1, Math.ceil(filtered.value.length / 12)),
  ),
  visible = computed(() =>
    filtered.value.slice((page.value - 1) * 12, page.value * 12),
  )
function update(patch: Record<string, string>) {
  router.push({
    path: '/products',
    query: { ...route.query, ...patch, page: undefined },
  })
}
function search() {
  update({ q: q.value.trim(), min: min.value, max: max.value })
}
</script>
<template>
  <div class="page-wrap">
    <div class="page-heading">
      <h1>
        {{
          route.query.q
            ? `搜索：${route.query.q}`
            : (shop.db.categories.find((c) => c.id === category)?.name ??
              '所有好物')
        }}
      </h1>
      <p>为日常挑一件用得上的。</p>
    </div>
    <form class="catalogue-search" @submit.prevent="search">
      <Search :size="21" /><input
        v-model="q"
        aria-label="搜索商品关键词"
        placeholder="搜索商品、材质或用途"
      /><button class="button" type="submit">搜索</button>
    </form>
    <div class="catalogue-layout">
      <aside class="catalogue-filters">
        <h2>商品分类</h2>
        <button
          :class="{ selected: !category }"
          @click="update({ category: '' })"
        >
          全部商品</button
        ><button
          v-for="c in shop.db.categories"
          :key="c.id"
          :class="{ selected: category === c.id }"
          @click="update({ category: c.id })"
        >
          {{ c.name }}
        </button>
        <form class="price-form" @submit.prevent="search">
          <h2>价格区间</h2>
          <label
            >最低价格<input
              v-model="min"
              type="number"
              min="0"
              placeholder="¥ 0" /></label
          ><label
            >最高价格<input
              v-model="max"
              type="number"
              :min="Number(min) || 0"
              placeholder="不限" /></label
          ><button class="button secondary-button">应用价格</button>
        </form>
        <RouterLink to="/products" class="text-link">清除筛选</RouterLink>
      </aside>
      <div class="catalogue-results">
        <div class="results-top">
          <p>共 {{ filtered.length }} 件商品</p>
          <label
            >排序
            <select
              :value="sort"
              @change="
                update({ sort: ($event.target as HTMLSelectElement).value })
              "
            >
              <option value="featured">推荐优先</option>
              <option value="price-asc">价格从低到高</option>
              <option value="price-desc">价格从高到低</option>
            </select></label
          >
        </div>
        <div v-if="visible.length" class="product-grid">
          <ProductCard v-for="p in visible" :key="p.id" :product="p" />
        </div>
        <div v-else class="empty-state">
          <h2>换个关键词试试</h2>
          <p>没有找到符合条件的商品，请调整分类或价格范围。</p>
          <RouterLink to="/products" class="button">查看全部商品</RouterLink>
        </div>
        <nav v-if="pages > 1" class="pagination" aria-label="商品分页">
          <button
            :disabled="page <= 1"
            @click="router.push({ query: { ...route.query, page: page - 1 } })"
          >
            上一页</button
          ><span>{{ page }} / {{ pages }}</span
          ><button
            :disabled="page >= pages"
            @click="router.push({ query: { ...route.query, page: page + 1 } })"
          >
            下一页
          </button>
        </nav>
      </div>
    </div>
  </div>
</template>
