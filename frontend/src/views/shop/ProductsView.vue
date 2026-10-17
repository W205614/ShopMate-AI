<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter, type LocationQueryRaw } from "vue-router";
import { Search, X } from "lucide-vue-next";
import { useShop } from "../../stores/shop";
import {
  catalogueCategories,
  PAGE_SIZE,
  queryText,
  readCatalogueQuery,
  searchProducts,
} from "../../domain/catalogue";
import { money } from "../../domain/types";
import ProductCard from "../../components/shop/ProductCard.vue";

const shop = useShop(),
  route = useRoute(),
  router = useRouter();
const q = ref(""),
  min = ref(""),
  max = ref(""),
  priceError = ref("");
const filters = computed(() => readCatalogueQuery(route.query));
const categories = computed(() =>
  catalogueCategories(shop.db.categories, shop.db.products),
);
const categoryName = computed(
  () =>
    categories.value.find((c) => c.id === filters.value.category)?.name ??
    "已失效分类",
);
watch(
  () => route.query,
  () => {
    q.value = filters.value.q;
    min.value =
      filters.value.min === undefined ? "" : String(filters.value.min / 100);
    max.value =
      filters.value.max === undefined ? "" : String(filters.value.max / 100);
    priceError.value = "";
  },
  { immediate: true },
);
const filtered = computed(() =>
  searchProducts(shop.db.products, shop.db.categories, filters.value),
);
const pages = computed(() =>
  Math.max(1, Math.ceil(filtered.value.length / PAGE_SIZE)),
);
const page = computed(() => Math.min(filters.value.page, pages.value));
const visible = computed(() =>
  filtered.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE),
);
const chips = computed(() => [
  ...(filters.value.q
    ? [{ key: "q", label: `关键词：${filters.value.q}` }]
    : []),
  ...(filters.value.category
    ? [{ key: "category", label: categoryName.value }]
    : []),
  ...(filters.value.min !== undefined
    ? [{ key: "min", label: `最低 ${money(filters.value.min)}` }]
    : []),
  ...(filters.value.max !== undefined
    ? [{ key: "max", label: `最高 ${money(filters.value.max)}` }]
    : []),
  ...(filters.value.inStock ? [{ key: "stock", label: "仅看有货" }] : []),
]);
function update(patch: Record<string, string | undefined>) {
  const query: LocationQueryRaw = { ...route.query, page: undefined, ...patch };
  for (const key of Object.keys(query)) if (!query[key]) delete query[key];
  void router.push({ path: "/products", query });
}
function applyPrices() {
  const value = readCatalogueQuery({ min: min.value, max: max.value });
  if (
    (min.value && value.min === undefined) ||
    (max.value && value.max === undefined)
  ) {
    priceError.value = "请输入非负价格，最多保留两位小数。";
    return;
  }
  if (value.invalidRange) {
    priceError.value = "最低价格不能高于最高价格。";
    return;
  }
  update({ min: min.value, max: max.value });
}
</script>
<template>
  <div class="page-wrap">
    <div class="page-heading">
      <h1>
        {{
          filters.q
            ? `搜索：${filters.q}`
            : filters.category
              ? categoryName
              : "所有好物"
        }}
      </h1>
      <p>为日常挑一件用得上的。</p>
    </div>
    <form
      class="catalogue-search"
      role="search"
      @submit.prevent="update({ q: q.trim() })"
    >
      <Search :size="21" /><input
        v-model="q"
        aria-label="搜索商品关键词"
        placeholder="搜索商品、材质或用途"
      />
      <button class="button" type="submit">搜索</button>
    </form>
    <div class="catalogue-layout">
      <aside class="catalogue-filters" aria-label="商品筛选">
        <h2>商品分类</h2>
        <button
          :class="{ selected: !filters.category }"
          :aria-pressed="!filters.category"
          @click="update({ category: undefined })"
        >
          全部商品
        </button>
        <button
          v-for="c in categories"
          :key="c.id"
          :class="{ selected: filters.category === c.id }"
          :aria-pressed="filters.category === c.id"
          @click="update({ category: c.id })"
        >
          {{ c.name }} <span class="secondary">{{ c.count }}</span>
        </button>
        <form class="price-form" novalidate @submit.prevent="applyPrices">
          <h2>价格区间</h2>
          <label
            >最低价格<input
              v-model="min"
              type="number"
              min="0"
              step="0.01"
              inputmode="decimal"
              placeholder="¥ 0"
              :aria-invalid="!!priceError"
              aria-describedby="price-error"
          /></label>
          <label
            >最高价格<input
              v-model="max"
              type="number"
              min="0"
              step="0.01"
              inputmode="decimal"
              placeholder="不限"
              :aria-invalid="!!priceError"
              aria-describedby="price-error"
          /></label>
          <button class="button secondary-button" type="submit">
            应用价格
          </button>
          <p
            v-if="priceError"
            id="price-error"
            role="alert"
            class="price-error"
          >
            {{ priceError }}
          </p>
        </form>
        <label class="stock-filter"
          ><input
            type="checkbox"
            :checked="filters.inStock"
            @change="
              update({
                stock: ($event.target as HTMLInputElement).checked
                  ? '1'
                  : undefined,
              })
            "
          />仅看有货</label
        >
        <RouterLink to="/products" class="text-link">清除筛选</RouterLink>
      </aside>
      <div class="catalogue-results">
        <div v-if="chips.length" class="filter-chips" aria-label="已选筛选">
          <button
            v-for="chip in chips"
            :key="chip.key"
            :aria-label="`移除${chip.label}`"
            @click="update({ [chip.key]: undefined })"
          >
            {{ chip.label }}<X :size="14" />
          </button>
        </div>
        <div class="results-top">
          <p role="status">
            共 {{ filtered.length }} 件商品<span v-if="filtered.length">
              · 第 {{ (page - 1) * PAGE_SIZE + 1 }}–{{
                Math.min(page * PAGE_SIZE, filtered.length)
              }}
              件</span
            >
          </p>
          <label
            >排序<select
              :value="filters.sort"
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
          <p>
            {{
              filters.invalidRange
                ? "最低价格不能高于最高价格，请重新设置价格区间。"
                : "没有找到符合条件的商品，请调整关键词、分类或价格范围。"
            }}
          </p>
          <RouterLink to="/products" class="button">查看全部商品</RouterLink>
        </div>
        <nav v-if="pages > 1" class="pagination" aria-label="商品分页">
          <button
            :disabled="page <= 1"
            @click="update({ page: String(page - 1) })"
          >
            上一页
          </button>
          <span>{{ page }} / {{ pages }}</span>
          <button
            :disabled="page >= pages"
            @click="update({ page: String(page + 1) })"
          >
            下一页
          </button>
        </nav>
        <p
          v-if="queryText(route.query.page) && filters.page > pages"
          class="secondary pagination-note"
        >
          已显示最后一页。
        </p>
      </div>
    </div>
  </div>
</template>
