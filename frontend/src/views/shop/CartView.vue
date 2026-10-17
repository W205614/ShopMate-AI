<script setup lang="ts">
import { computed } from "vue";
import { useShop } from "../../stores/shop";
import { api } from "../../services/api";
import { money } from "../../domain/types";
import { Minus, Plus, Trash2, ArrowRight } from "lucide-vue-next";
import { useAction } from "../../components/shop/useAction";
import ActionNotice from "../../components/shop/ActionNotice.vue";
const shop = useShop(),
  { busy, error, notice, run } = useAction();
const rows = computed(() =>
    shop.myCart.map((item) => {
      const product = shop.db.products.find((p) => p.id === item.productId);
      return {
        item,
        product,
        sku: product?.skus.find((s) => s.id === item.skuId),
      };
    }),
  ),
  selected = computed(() => rows.value.filter((r) => r.item.selected)),
  eligible = computed(() =>
    rows.value.filter(
      (r) => r.product?.active && r.sku && r.sku.stock >= r.item.quantity,
    ),
  ),
  total = computed(() =>
    selected.value.reduce(
      (sum, r) => sum + (r.sku?.price ?? 0) * r.item.quantity,
      0,
    ),
  ),
  valid = computed(
    () =>
      selected.value.length > 0 &&
      selected.value.every(
        (r) => r.product?.active && r.sku && r.sku.stock >= r.item.quantity,
      ),
  );
function update(id: string, patch: { quantity?: number; selected?: boolean }) {
  return run(() => api.updateCart(id, patch));
}
function remove(id: string) {
  return run(() => api.removeCart(id), "已移除商品");
}
async function selectAll(event: Event) {
  const checked = (event.target as HTMLInputElement).checked;
  await run(async () => {
    await api.batchCart({
      ids: rows.value.map((r) => r.item.id),
      action: "select",
      selected: checked,
    });
  });
}
function removeSelected() {
  if (window.confirm("确认删除所选商品？"))
    return run(
      () =>
        api.batchCart({
          ids: selected.value.map((r) => r.item.id),
          action: "remove",
        }),
      "已删除所选商品",
    );
}
function clearInvalid() {
  return run(
    () => api.clearInvalidCart(),
    "已清理下架商品和失效规格；缺货商品仍保留",
  );
}
</script>
<template>
  <div class="page-wrap">
    <div class="page-heading">
      <h1>购物车</h1>
      <p>选好规格，再把喜欢的带回家。</p>
    </div>
    <ActionNotice :error="error" :notice="notice" />
    <div v-if="rows.length" class="cart-layout" data-ui>
      <div class="cart-list">
        <label class="check-label cart-select-all"
          ><input
            type="checkbox"
            :checked="
              eligible.length > 0 && eligible.every((r) => r.item.selected)
            "
            :disabled="busy"
            @change="selectAll"
          />全选 <span class="secondary">{{ rows.length }} 种商品</span></label
        >
        <div class="button-row">
          <button :disabled="busy || !selected.length" @click="removeSelected">
            删除所选</button
          ><button :disabled="busy" @click="clearInvalid">清理失效商品</button>
        </div>
        <article v-for="r in rows" :key="r.item.id" class="cart-row">
          <input
            type="checkbox"
            :aria-label="`选择 ${r.product?.name ?? '失效商品'}`"
            :checked="r.item.selected"
            :disabled="busy"
            @change="
              update(r.item.id, {
                selected: ($event.target as HTMLInputElement).checked,
              })
            "
          /><RouterLink :to="`/products/${r.item.productId}`"
            ><img
              :src="r.product?.images[0]"
              :alt="r.product?.name ?? '商品已移除'"
          /></RouterLink>
          <div class="cart-product">
            <RouterLink :to="`/products/${r.item.productId}`">{{
              r.product?.name ?? "失效商品"
            }}</RouterLink>
            <p class="secondary">{{ r.sku?.name ?? "规格已失效" }}</p>
            <strong>{{ money(r.sku?.price ?? 0) }}</strong>
            <p v-if="!r.product?.active || !r.sku" class="stock-error">
              商品已下架或规格失效
            </p>
            <p v-else-if="r.sku.stock < r.item.quantity" class="stock-error">
              库存不足，仅剩 {{ r.sku.stock }} 件
            </p>
          </div>
          <div class="cart-row-end">
            <div class="quantity-control">
              <button
                :disabled="busy || r.item.quantity <= 1"
                aria-label="减少数量"
                @click="update(r.item.id, { quantity: r.item.quantity - 1 })"
              >
                <Minus :size="15" /></button
              ><span>{{ r.item.quantity }}</span
              ><button
                :disabled="busy || r.item.quantity >= (r.sku?.stock ?? 0)"
                aria-label="增加数量"
                @click="update(r.item.id, { quantity: r.item.quantity + 1 })"
              >
                <Plus :size="15" />
              </button>
            </div>
            <button
              class="icon-text-button"
              :disabled="busy"
              @click="remove(r.item.id)"
            >
              <Trash2 :size="16" />移除
            </button>
          </div>
        </article>
      </div>
      <aside class="order-summary">
        <h2>选购小计</h2>
        <div>
          <span>已选商品</span
          ><span
            >{{
              selected.reduce((sum, r) => sum + r.item.quantity, 0)
            }}
            件</span
          >
        </div>
        <div><span>配送费</span><span>免运费</span></div>
        <div class="summary-total">
          <span>合计</span><strong>{{ money(total) }}</strong>
        </div>
        <RouterLink v-if="valid && !busy" to="/checkout" class="button"
          >去结算 <ArrowRight :size="18" /></RouterLink
        ><button v-else class="button" disabled>请选择有库存的商品</button>
        <p class="secondary">演示交易，不会产生真实付款。</p>
      </aside>
    </div>
    <div v-else class="empty-state">
      <h2>还没有想带走的好物</h2>
      <p>先去逛逛，把喜欢的加入购物车。</p>
      <RouterLink to="/products" class="button">浏览商品</RouterLink>
    </div>
  </div>
</template>
