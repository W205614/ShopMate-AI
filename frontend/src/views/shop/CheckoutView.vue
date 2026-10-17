<script setup lang="ts">
import { computed, ref, watch, onUnmounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useShop } from "../../stores/shop";
import { api } from "../../services/api";
import { money, dateTime } from "../../domain/types";
import type {
  Address,
  AddressInput,
  CheckoutQuote,
  CheckoutSource,
} from "../../domain/types";
import OrderItems from "../../components/shop/OrderItems.vue";
import ActionNotice from "../../components/shop/ActionNotice.vue";
import CheckoutAddressForm from "../../components/shop/CheckoutAddressForm.vue";
import "../../styles/commerce-flow.css";
const shop = useShop(),
  router = useRouter(),
  route = useRoute();
const cartIds = ref(shop.myCart.filter((i) => i.selected).map((i) => i.id));
const source = computed<CheckoutSource>(() =>
  route.query.productId || route.query.skuId
    ? {
        type: "buyNow",
        productId: String(route.query.productId ?? ""),
        skuId: String(route.query.skuId ?? ""),
        quantity: Number(route.query.quantity ?? 1),
      }
    : { type: "cart", cartIds: cartIds.value },
);
const addressId = ref(""),
  couponClaimId = ref(""),
  quote = ref<CheckoutQuote>(),
  error = ref(""),
  notice = ref(""),
  quoting = ref(false),
  submitting = ref(false),
  saving = ref(false),
  editing = ref(false),
  editAddress = ref<Address>(),
  requestId = ref(""),
  stale = ref(false);
let generation = 0;
const now = ref(Date.now()),
  timer = window.setInterval(() => {
    now.value = Date.now();
  }, 1000);
onUnmounted(() => {
  window.clearInterval(timer);
  generation++;
});
const hasSource = computed(
  () => source.value.type === "buyNow" || source.value.cartIds.length > 0,
);
const couponOptions = computed(() =>
  shop.db.couponClaims
    .filter((c) => c.userId === shop.userId && c.status === "available")
    .flatMap((claim) => {
      const coupon = shop.db.coupons.find((c) => c.id === claim.couponId);
      return coupon &&
        coupon.active &&
        Date.parse(coupon.validFrom) <= now.value &&
        Date.parse(coupon.validUntil) > now.value
        ? [{ claim, coupon }]
        : [];
    }),
);
watch(
  () => shop.myAddresses.map((a) => a.id).join(","),
  () => {
    if (!shop.myAddresses.some((a) => a.id === addressId.value))
      addressId.value =
        shop.myAddresses.find((a) => a.isDefault)?.id ??
        shop.myAddresses[0]?.id ??
        "";
  },
  { immediate: true },
);
const fingerprint = computed(() => {
  const input = source.value;
  const entries =
    input.type === "buyNow"
      ? [input]
      : shop.myCart.filter((i) => cartIds.value.includes(i.id));
  const claim = shop.db.couponClaims.find((c) => c.id === couponClaimId.value);
  const coupon = shop.db.coupons.find((c) => c.id === claim?.couponId);
  return JSON.stringify({
    choice: JSON.stringify({
      source: input,
      addressId: addressId.value,
      couponClaimId: couponClaimId.value,
    }),
    address: shop.myAddresses.find((a) => a.id === addressId.value),
    products: entries.map((entry) => {
      const p = shop.db.products.find((p) => p.id === entry.productId),
        s = p?.skus.find((s) => s.id === entry.skuId);
      return {
        id: p?.id,
        active: p?.active,
        name: p?.name,
        image: p?.images[0],
        skuId: s?.id,
        skuName: s?.name,
        price: s?.price,
        sufficient: (s?.stock ?? 0) >= entry.quantity,
      };
    }),
    cart: input.type === "cart" ? entries : [],
    claim,
    coupon,
    couponValid:
      !coupon ||
      (Date.parse(coupon.validFrom) <= now.value &&
        Date.parse(coupon.validUntil) > now.value),
  });
});
async function refreshQuote() {
  const current = ++generation;
  quote.value = undefined;
  error.value = "";
  stale.value = false;
  quoting.value = false;
  if (!addressId.value || !hasSource.value || submitting.value) return;
  quoting.value = true;
  try {
    const result = await api.quoteCheckout({
      source: source.value,
      addressId: addressId.value,
      ...(couponClaimId.value ? { couponClaimId: couponClaimId.value } : {}),
    });
    if (current === generation) {
      quote.value = result;
      requestId.value = crypto.randomUUID();
      notice.value = "报价已更新，请确认商品明细、地址与应付金额后提交订单。";
    }
  } catch (e) {
    if (current === generation)
      error.value = e instanceof Error ? e.message : "无法获取报价，请重试";
  } finally {
    if (current === generation) quoting.value = false;
  }
}
watch(
  fingerprint,
  (value, previous) => {
    if (submitting.value) return;
    if (!previous || JSON.parse(value).choice !== JSON.parse(previous).choice) {
      void refreshQuote();
      return;
    }
    generation++;
    quoting.value = false;
    quote.value = undefined;
    stale.value = true;
    notice.value =
      "商品、地址、优惠券或购物车已变化，请重新获取报价并确认金额。";
  },
  { immediate: true },
);
const expired = computed(
  () => !!quote.value && Date.parse(quote.value.expiresAt) <= now.value,
);
function edit(address?: Address) {
  editAddress.value = address;
  editing.value = true;
}
async function saveAddress(input: AddressInput) {
  saving.value = true;
  error.value = "";
  try {
    await api.saveAddress(input);
    editing.value = false;
    notice.value = "收货地址已保存，请确认更新后的报价。";
  } catch (e) {
    error.value = e instanceof Error ? e.message : "保存地址失败";
  } finally {
    saving.value = false;
  }
}
async function submit() {
  if (!quote.value || expired.value || submitting.value || quoting.value)
    return;
  submitting.value = true;
  error.value = "";
  try {
    const id = await api.createOrder({
      quoteId: quote.value.id,
      requestId: requestId.value,
    });
    await router.push(`/orders/${id}/pay`);
  } catch (e) {
    error.value =
      e instanceof Error ? e.message : "提交失败，请重试；重复提交不会重复下单";
    submitting.value = false;
  }
}
</script>
<template>
  <div class="page-wrap">
    <div class="page-heading">
      <h1>确认订单</h1>
      <p>
        {{
          source.type === "buyNow"
            ? "立即购买独立结算，不会修改购物车。"
            : "确认收货地址、优惠和服务端报价。"
        }}
      </p>
    </div>
    <ActionNotice :error="error" :notice="notice" />
    <div v-if="hasSource" class="cart-layout checkout-layout" data-ui>
      <div>
        <section class="checkout-section">
          <div class="section-heading">
            <h2>寄到这里</h2>
            <button
              class="text-link"
              :disabled="submitting || saving"
              @click="edit()"
            >
              添加地址
            </button>
          </div>
          <CheckoutAddressForm
            v-if="editing"
            :key="editAddress?.id ?? 'new'"
            :address="editAddress"
            :first="!shop.myAddresses.length"
            :busy="saving"
            @save="saveAddress"
            @cancel="editing = false"
          />
          <div v-if="shop.myAddresses.length" class="address-options">
            <div
              v-for="a in shop.myAddresses"
              :key="a.id"
              class="checkout-address-row"
            >
              <label :class="{ selected: addressId === a.id }"
                ><input
                  v-model="addressId"
                  type="radio"
                  name="address"
                  :value="a.id"
                  :disabled="submitting || saving"
                />
                <div>
                  <strong>{{ a.name }} · {{ a.phone }}</strong>
                  <p>{{ a.region }} {{ a.detail }}</p>
                  <span v-if="a.isDefault" class="secondary">默认收货地址</span>
                </div></label
              >
              <button
                class="text-link"
                :aria-label="`编辑 ${a.name} 的地址`"
                :disabled="submitting || saving"
                @click="edit(a)"
              >
                编辑
              </button>
            </div>
          </div>
          <p v-else class="empty-inline">请添加一个收货地址后获取报价。</p>
        </section>
        <section class="checkout-section form-stack">
          <h2>优惠券</h2>
          <label
            >使用优惠券<select v-model="couponClaimId" :disabled="submitting">
              <option value="">不使用优惠券</option>
              <option
                v-for="{ claim, coupon } in couponOptions"
                :key="claim.id"
                :value="claim.id"
              >
                {{ coupon.name }} · 满 {{ money(coupon.threshold) }} 减
                {{ money(coupon.discount) }}
              </option>
            </select></label
          ><RouterLink to="/account?section=coupons" class="text-link"
            >查看我的优惠券与领券中心</RouterLink
          >
        </section>
        <section class="checkout-section">
          <h2>你选的好物</h2>
          <OrderItems v-if="quote" :items="quote.items" />
          <p v-else>
            {{
              quoting
                ? "正在核实商品、库存和价格…"
                : "请获取有效报价以确认商品明细。"
            }}
          </p>
          <RouterLink v-if="source.type === 'cart'" to="/cart" class="text-link"
            >返回购物车修改</RouterLink
          >
        </section>
      </div>
      <aside class="order-summary">
        <h2>订单金额</h2>
        <template v-if="quote"
          ><div>
            <span>商品小计</span><span>{{ money(quote.subtotal) }}</span>
          </div>
          <div>
            <span>优惠减免</span><span>−{{ money(quote.discount) }}</span>
          </div>
          <div><span>配送费</span><span>¥0.00</span></div>
          <div class="summary-total">
            <span>应付金额</span><strong>{{ money(quote.total) }}</strong>
          </div>
          <p class="secondary">
            报价有效至 {{ dateTime(quote.expiresAt) }}
          </p></template
        >
        <p v-if="expired || stale" role="status" class="stock-error">
          {{
            stale
              ? "结算信息已变化，请重新获取并确认报价。"
              : "报价已过期，请重新获取并确认金额。"
          }}
        </p>
        <button
          class="button"
          :disabled="
            submitting || quoting || saving || !quote || expired || stale
          "
          @click="submit"
        >
          {{ submitting ? "正在提交…" : "提交订单" }}</button
        ><button
          class="text-link"
          :disabled="submitting || quoting || !addressId"
          @click="refreshQuote"
        >
          {{ quoting ? "正在更新报价…" : "重新获取报价" }}
        </button>
        <p class="secondary">
          下单后 30 分钟内完成模拟支付。最终库存由服务端在付款时校验。
        </p>
      </aside>
    </div>
    <div v-else class="empty-state">
      <h2>没有待结算的商品</h2>
      <p>请在购物车勾选商品，或从商品详情立即购买。</p>
      <RouterLink to="/cart" class="button">返回购物车</RouterLink>
    </div>
  </div>
</template>
