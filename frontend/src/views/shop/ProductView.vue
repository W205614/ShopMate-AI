<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  ArrowUpRight,
  Heart,
  Minus,
  Plus,
  MessageCircle,
} from "lucide-vue-next";
import { useShop } from "../../stores/shop";
import { api } from "../../services/api";
import { money } from "../../domain/types";
import { useAction } from "../../components/shop/useAction";
import ActionNotice from "../../components/shop/ActionNotice.vue";
import ProductCard from "../../components/shop/ProductCard.vue";
import ProductReviews from "../../components/shop/ProductReviews.vue";
const shop = useShop(),
  route = useRoute(),
  router = useRouter(),
  selected = ref(""),
  image = ref(0),
  quantity = ref(1),
  { busy, pending, error, notice, run } = useAction();
const product = computed(() =>
    shop.db.products.find((p) => p.id === route.params.id),
  ),
  sku = computed(
    () =>
      product.value?.skus.find((s) => s.id === selected.value) ??
      product.value?.skus[0],
  ),
  favorite = computed(
    () => !!shop.db.favorites[shop.userId]?.includes(String(route.params.id)),
  ),
  related = computed(() =>
    shop.db.products
      .filter(
        (p) =>
          p.active &&
          p.categoryId === product.value?.categoryId &&
          p.id !== product.value?.id,
      )
      .slice(0, 4),
  );
watch(
  () => route.params.id,
  () => {
    selected.value = "";
    image.value = 0;
    quantity.value = 1;
    error.value = "";
    notice.value = "";
  },
);
function requireLogin() {
  if (shop.user) return true;
  router.push({ path: "/login", query: { redirect: route.fullPath } });
  return false;
}
function selectSku(id: string) {
  selected.value = id;
  quantity.value = 1;
}
async function add() {
  if (!requireLogin() || !product.value || !sku.value) return;
  await run(
    () => api.addCart(product.value!.id, sku.value!.id, quantity.value),
    "已加入购物车，可以继续选购。",
  );
}
function buyNow() {
  if (!requireLogin() || !product.value || !sku.value) return;
  if (
    !Number.isInteger(quantity.value) ||
    quantity.value < 1 ||
    quantity.value > sku.value.stock
  ) {
    error.value = "请选择库存范围内的整数数量";
    return;
  }
  router.push({
    path: "/checkout",
    query: {
      productId: product.value.id,
      skuId: sku.value.id,
      quantity: String(quantity.value),
    },
  });
}
async function toggleFavorite() {
  if (requireLogin() && product.value)
    await run(
      () => api.favorite(product.value!.id),
      favorite.value ? "已取消收藏" : "已加入收藏",
    );
}
</script>
<template>
  <div v-if="product" class="page-wrap">
    <nav class="breadcrumb" aria-label="面包屑">
      <RouterLink to="/">首页</RouterLink><span>/</span
      ><RouterLink
        :to="{ path: '/products', query: { category: product.categoryId } }"
        >{{
          shop.db.categories.find((c) => c.id === product?.categoryId)?.name
        }}</RouterLink
      ><span>/</span><span>{{ product.name }}</span>
    </nav>
    <div class="product-detail">
      <div class="detail-gallery">
        <div class="detail-photo">
          <img
            :src="product.images[image] ?? product.images[0]"
            :alt="product.name"
          />
        </div>
        <div v-if="product.images.length > 1" class="thumbnail-row">
          <button
            v-for="(src, i) in product.images"
            :key="i"
            :class="{ selected: image === i }"
            :aria-label="`查看第 ${i + 1} 张商品图片`"
            @click="image = i"
          >
            <img :src="src" :alt="`${product.name} 视图 ${i + 1}`" />
          </button>
        </div>
        <p class="secondary">
          图片与规格为演示素材，不代表真实在售商品或品牌授权。
        </p>
      </div>
      <div class="detail-info">
        <h1>{{ product.name }}</h1>
        <p class="product-subtitle">{{ product.subtitle }}</p>
        <p class="detail-price">{{ money(sku?.price ?? 0) }}</p>
        <div v-if="!product.active" class="action-error" role="status">
          此商品已下架，暂时无法购买。
        </div>
        <div class="sku-picker">
          <h2>选择规格</h2>
          <div>
            <button
              v-for="s in product.skus"
              :key="s.id"
              :class="{ selected: sku?.id === s.id }"
              :aria-pressed="sku?.id === s.id"
              @click="selectSku(s.id)"
            >
              {{ s.name }}
            </button>
          </div>
          <p class="secondary">
            {{ sku?.stock ? `当前库存 ${sku.stock} 件` : "当前规格暂时售罄" }}
          </p>
        </div>
        <div class="quantity-row">
          <span>数量</span>
          <div class="quantity-control">
            <button
              :disabled="quantity <= 1"
              aria-label="减少数量"
              @click="quantity--"
            >
              <Minus :size="16" /></button
            ><input
              v-model.number="quantity"
              aria-label="购买数量"
              type="number"
              min="1"
              :max="sku?.stock || 1"
            /><button
              :disabled="quantity >= (sku?.stock ?? 0)"
              aria-label="增加数量"
              @click="quantity++"
            >
              <Plus :size="16" />
            </button>
          </div>
        </div>
        <div class="purchase-actions">
          <button
            class="button secondary-button"
            :disabled="busy || !product.active || !sku?.stock"
            @click="buyNow"
          >
            立即购买
          </button>
          <button
            class="button"
            :disabled="busy || !product.active || !sku?.stock"
            @click="add"
          >
            {{ pending ? "处理中…" : "加入购物车" }}
            <ArrowUpRight :size="20" /></button
          ><button
            class="favorite-button"
            :class="{ selected: favorite }"
            :disabled="busy"
            :aria-label="favorite ? '取消收藏' : '收藏商品'"
            @click="toggleFavorite"
          >
            <Heart :size="21" :fill="favorite ? 'currentColor' : 'none'" />
          </button>
        </div>
        <ActionNotice :error="error" :notice="notice" /><RouterLink
          :to="{ path: '/support', query: { productId: product.id } }"
          class="detail-ask"
          ><MessageCircle :size="20" /><span>这件适合我吗？问问购物伙伴</span
          ><ArrowUpRight :size="18"
        /></RouterLink>
        <div class="product-policies">
          <details open>
            <summary>商品说明</summary>
            <p>{{ product.description }}</p>
            <p>材质与特性：{{ product.material }}</p>
          </details>
          <details>
            <summary>配送与收货</summary>
            <p>
              本演示免运费。提交订单后，可在管理端填写模拟快递信息并发货；不会产生真实包裹。
            </p>
          </details>
          <details>
            <summary>退换与售后</summary>
            <p>
              已付款订单可以申请售后。未发货订单审核后退款，已发货订单需退货确认后退款。所有处理均为本地模拟。
            </p>
          </details>
        </div>
      </div>
    </div>
    <ProductReviews :product-id="product.id" />
    <section v-if="related.length" class="related-products">
      <div class="section-heading">
        <h2>也许你还会喜欢</h2>
        <RouterLink to="/products">继续选购</RouterLink>
      </div>
      <div class="product-grid">
        <ProductCard v-for="p in related" :key="p.id" :product="p" />
      </div>
    </section>
  </div>
  <div v-else class="empty-state">
    <h1>没有找到这件商品</h1>
    <p>它可能已经被移除，请回到商品目录继续浏览。</p>
    <RouterLink to="/products" class="button">浏览商品</RouterLink>
  </div>
</template>
