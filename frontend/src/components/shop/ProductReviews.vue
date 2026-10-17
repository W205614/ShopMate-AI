<script setup lang="ts">
import { ref, watch } from "vue";
import { useShop } from "../../stores/shop";
import { request } from "../../services/repository";
import type { PublicReviews } from "../../domain/types";
import { dateTime } from "../../domain/types";
import "../../styles/account-commerce.css";

const props = defineProps<{ productId: string }>();
const shop = useShop();
const page = ref(1),
  loading = ref(false),
  error = ref("");
const data = ref<PublicReviews>({
  items: [],
  total: 0,
  page: 1,
  pages: 1,
  averageRating: 0,
});
let sequence = 0;
async function load() {
  const current = ++sequence;
  loading.value = true;
  error.value = "";
  try {
    const response = await request<PublicReviews>(
      `/api/products/${encodeURIComponent(props.productId)}/reviews?page=${page.value}`,
    );
    if (current !== sequence) return;
    data.value = response;
    if (page.value !== response.page) page.value = response.page;
  } catch (cause) {
    if (current === sequence)
      error.value = cause instanceof Error ? cause.message : "暂时无法读取评价";
  } finally {
    if (current === sequence) loading.value = false;
  }
}
watch(
  () => props.productId,
  () => {
    page.value = 1;
    void load();
  },
  { immediate: true },
);
watch(page, () => {
  void load();
});
watch(
  () => shop.db.revision,
  () => {
    void load();
  },
);
</script>
<template>
  <section class="product-reviews" aria-label="商品评价" :aria-busy="loading">
    <div class="section-heading">
      <h2>购买者的使用感受</h2>
      <span
        >{{ data.total }} 条评价<span v-if="data.total">
          · {{ data.averageRating.toFixed(1) }} / 5 星</span
        ></span
      >
    </div>
    <div v-if="error" role="alert">
      <p>{{ error }}</p>
      <button class="text-link" @click="load">重新加载评价</button>
    </div>
    <div v-else-if="data.items.length" class="commerce-list">
      <article
        v-for="review in data.items"
        :key="review.id"
        class="commerce-list-card"
      >
        <div class="public-review-meta">
          <strong>{{ review.displayName }}</strong
          ><span>{{ review.rating }} 星</span
          ><time :datetime="review.createdAt">{{
            dateTime(review.createdAt)
          }}</time>
        </div>
        <p class="review-content">{{ review.content }}</p>
      </article>
    </div>
    <p v-else class="secondary">
      {{ loading ? "正在读取评价…" : "还没有评价，期待购买者分享使用感受。" }}
    </p>
    <nav
      v-if="data.pages > 1"
      class="commerce-pagination"
      aria-label="评价分页"
    >
      <button :disabled="loading || page <= 1" @click="page--">上一页</button
      ><span>第 {{ data.page }} / {{ data.pages }} 页</span
      ><button :disabled="loading || page >= data.pages" @click="page++">
        下一页
      </button>
    </nav>
  </section>
</template>
