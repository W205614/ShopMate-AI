<script setup lang="ts">
import { computed, ref, watch, onUnmounted, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useShop } from "../../stores/shop";
import { api, RequestError } from "../../services/api";
import {
  loadCheckoutRecovery,
  saveCheckoutRecovery,
  clearCheckoutRecovery,
  checkoutRecoveryPath,
} from "../../services/checkoutRecovery";
import type { CheckoutRecovery } from "../../services/checkoutRecovery";
import { money, dateTime } from "../../domain/types";
import { couponRules, couponUseReason } from "../../domain/coupons";
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
const recovery = ref<CheckoutRecovery | null>(null),
  checking = ref(false),
  recoveryChecked = ref(false),
  recoveryRejected = ref(false);
const recoveryMatches = computed(
  () =>
    route.path === "/checkout" &&
    recovery.value?.checkoutPath === checkoutRecoveryPath(route.fullPath),
);
const disconnected = computed(() => shop.syncStatus.phase !== "ready");
try {
  recovery.value = loadCheckoutRecovery(shop.userId);
} catch {
  /* A new submission must first save its own recovery marker. */
}
const cartIds = ref(
  typeof route.query.cartIds === "string"
    ? route.query.cartIds.split(",").filter(Boolean)
    : shop.myCart.filter((i) => i.selected).map((i) => i.id),
);
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
let alive = true;
onUnmounted(() => {
  alive = false;
  window.clearInterval(timer);
  generation++;
});
const hasSource = computed(
  () => source.value.type === "buyNow" || source.value.cartIds.length > 0,
);
const subtotal = computed(() => {
  const input = source.value;
  const entries =
    input.type === "buyNow"
      ? [input]
      : shop.myCart.filter((i) => input.cartIds.includes(i.id));
  if (!entries.length) return null;
  let total = 0n;
  for (const entry of entries) {
    const product = shop.db.products.find((p) => p.id === entry.productId),
      sku = product?.skus.find((s) => s.id === entry.skuId);
    if (
      !product?.active ||
      !sku ||
      !Number.isSafeInteger(entry.quantity) ||
      entry.quantity < 1
    )
      return null;
    total += BigInt(sku.price) * BigInt(entry.quantity);
  }
  return total > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(total);
});
const couponOptions = computed(() =>
  shop.db.couponClaims
    .filter((c) => c.userId === shop.userId && c.status === "available")
    .flatMap((claim) => {
      const coupon = shop.db.coupons.find((c) => c.id === claim.couponId);
      return coupon
        ? [
            {
              claim,
              coupon,
              reason: couponUseReason(coupon, subtotal.value, now.value),
            },
          ]
        : [];
    }),
);
const selectedCouponReason = computed(() =>
  couponClaimId.value
    ? (couponOptions.value.find((c) => c.claim.id === couponClaimId.value)
        ?.reason ?? "优惠券已被占用或不可用")
    : "",
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
    coupon: couponRules(coupon),
    couponValid:
      !coupon ||
      (Date.parse(coupon.validFrom) <= now.value &&
        Date.parse(coupon.validUntil) > now.value),
  });
});
async function refreshQuote() {
  if (recovery.value) return;
  const current = ++generation;
  quote.value = undefined;
  error.value = "";
  stale.value = false;
  quoting.value = false;
  if (!addressId.value || !hasSource.value || submitting.value) return;
  if (selectedCouponReason.value) {
    error.value = selectedCouponReason.value;
    return;
  }
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
    if (submitting.value || recovery.value) return;
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
  if (saving.value) return;
  const previousIds = new Set(shop.myAddresses.map((address) => address.id));
  saving.value = true;
  error.value = "";
  try {
    await api.saveAddress(input);
    const saved = shop.myAddresses.find((address) =>
      input.id
        ? address.id === input.id
        : !previousIds.has(address.id) &&
          address.name === input.name.trim() &&
          address.phone === input.phone.trim() &&
          address.region === input.region.trim() &&
          address.detail === input.detail.trim() &&
          address.province === input.province?.trim(),
    );
    if (saved) addressId.value = saved.id;
    editing.value = false;
    notice.value = saved
      ? "收货地址已保存并选中，请确认更新后的地址与报价。"
      : "收货地址已保存，请选择收货地址并确认报价。";
  } catch (e) {
    error.value = e instanceof Error ? e.message : "保存地址失败";
  } finally {
    saving.value = false;
  }
}
function currentRecovery(marker: CheckoutRecovery) {
  return (
    alive &&
    shop.userId === marker.userId &&
    recovery.value === marker &&
    recoveryMatches.value
  );
}
async function openOrder(id: string, original: CheckoutRecovery) {
  if (!currentRecovery(original)) return;
  const order = shop.myOrders.find((o) => o.id === id);
  const destination =
    order && order.status !== "pending" ? `/orders/${id}` : `/orders/${id}/pay`;
  const failure = await router.push(destination);
  if (failure || router.currentRoute.value.path !== destination)
    throw Error("订单已找到，页面暂未打开，请重新核对订单");
  if (shop.userId === original.userId)
    clearCheckoutRecovery(original.userId, original);
}
async function checkRecovery() {
  if (
    !recovery.value ||
    !recoveryMatches.value ||
    checking.value ||
    submitting.value
  )
    return;
  checking.value = true;
  error.value = "";
  const marker = recovery.value;
  try {
    const id = await api.resolveOrderRequest(marker);
    if (!currentRecovery(marker)) return;
    recoveryChecked.value = true;
    if (id) await openOrder(id, marker);
    else
      notice.value =
        "尚未查询到订单。原请求可能仍在途中，请按原请求重试或继续核对。";
  } catch (e) {
    error.value =
      e instanceof Error ? e.message : "无法核对上次提交，请稍后重试";
  } finally {
    checking.value = false;
  }
}
async function retireRecovery() {
  if (!recovery.value || submitting.value || disconnected.value) return;
  submitting.value = true;
  error.value = "";
  const marker = recovery.value;
  try {
    const id = await api.retireCheckout(marker);
    if (!currentRecovery(marker)) return;
    if (id) {
      await openOrder(id, marker);
      return;
    }
    clearCheckoutRecovery(marker.userId, marker);
    recovery.value = null;
    quote.value = undefined;
    stale.value = true;
    cartIds.value = shop.myCart.filter((i) => i.selected).map((i) => i.id);
    notice.value = "原报价已关闭，请重新获取报价并确认商品及金额。";
  } catch (e) {
    error.value = e instanceof Error ? e.message : "无法结束原请求，请继续核对";
  } finally {
    submitting.value = false;
  }
}
async function retryOriginal() {
  if (
    !recovery.value ||
    !recoveryMatches.value ||
    submitting.value ||
    disconnected.value
  )
    return;
  submitting.value = true;
  error.value = "";
  const marker = recovery.value;
  try {
    const id = await api.createOrder({
      quoteId: marker.quoteId,
      requestId: marker.requestId,
    });
    await openOrder(id, marker);
  } catch (e) {
    error.value =
      e instanceof Error ? e.message : "提交结果暂无法确认，请核对原请求";
    recoveryRejected.value =
      e instanceof RequestError && e.outcome === "rejected" && e.status === 400;
  } finally {
    submitting.value = false;
  }
}
async function submit() {
  if (
    !quote.value ||
    expired.value ||
    submitting.value ||
    saving.value ||
    editing.value ||
    quoting.value ||
    recovery.value ||
    selectedCouponReason.value ||
    disconnected.value
  )
    return;
  try {
    const marker: CheckoutRecovery = {
      userId: shop.userId,
      quoteId: quote.value.id,
      requestId: requestId.value,
      checkoutPath: checkoutRecoveryPath(route.fullPath),
      createdAt: Date.now(),
    };
    saveCheckoutRecovery(marker);
    recovery.value = marker;
    await retryOriginal();
  } catch {
    error.value =
      "无法保存结算恢复标识，请允许浏览器会话存储后重试；尚未提交订单。";
  }
}
onMounted(() => {
  if (recovery.value && recoveryMatches.value) void checkRecovery();
});
watch(
  () => route.fullPath,
  () => {
    if (recovery.value && recoveryMatches.value) void checkRecovery();
  },
);
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
    <section v-if="recovery" class="checkout-section" aria-label="核对上次提交">
      <h2>核对上次提交</h2>
      <p>恢复期间保留原报价和请求标识，不会自动下新订单或付款。</p>
      <template v-if="recoveryMatches">
        <button
          class="button"
          :disabled="checking || submitting"
          @click="checkRecovery"
        >
          {{ checking ? "正在核对…" : "核对订单" }}
        </button>
        <button
          class="text-link"
          :disabled="checking || submitting || disconnected"
          @click="retryOriginal"
        >
          {{ submitting ? "正在处理…" : "按原请求重试" }}
        </button>
        <button
          v-if="recoveryChecked || recoveryRejected"
          class="text-link"
          :disabled="checking || submitting || disconnected"
          @click="retireRecovery"
        >
          关闭原报价并重新确认
        </button>
      </template>
      <RouterLink v-else :to="recovery.checkoutPath" class="button"
        >返回原结算核对</RouterLink
      >
      <RouterLink to="/orders" class="text-link">查看我的订单</RouterLink>
    </section>
    <div v-else-if="hasSource" class="cart-layout checkout-layout" data-ui>
      <div>
        <section class="checkout-section">
          <div class="section-heading">
            <h2>寄到这里</h2>
            <button
              class="text-link"
              :disabled="submitting || saving || disconnected"
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
                  :disabled="submitting || saving || disconnected"
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
                :disabled="submitting || saving || disconnected"
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
          <label for="checkout-coupon">使用优惠券</label>
          <select
            id="checkout-coupon"
            v-model="couponClaimId"
            aria-label="使用优惠券"
            :disabled="submitting || disconnected"
          >
            <option value="">自动选择最优优惠（满减同额优先）</option>
            <option
              v-for="{ claim, coupon, reason } in couponOptions"
              :key="claim.id"
              :value="claim.id"
              :disabled="!!reason"
            >
              {{ coupon.name }} · 满 {{ money(coupon.threshold) }} 减
              {{ money(coupon.discount) }}
              {{ reason ? ` · ${reason}` : "" }}
            </option>
          </select>
          <ul
            v-if="couponOptions.some((c) => c.reason)"
            class="secondary"
            aria-label="优惠券不可用原因"
          >
            <li
              v-for="option in couponOptions.filter((c) => c.reason)"
              :key="option.claim.id"
            >
              {{ option.coupon.name }}：{{ option.reason }}
            </li>
          </ul>
          <p v-if="selectedCouponReason" class="stock-error" role="status">
            当前选择的优惠券不可用，请取消用券并重新确认报价。
          </p>
          <RouterLink to="/account?section=coupons" class="text-link"
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
            <span
              >优惠减免{{
                quote.promotion
                  ? ` · ${quote.promotion.name}`
                  : quote.coupon
                    ? ` · ${quote.coupon.name}`
                    : ""
              }}</span
            ><span>−{{ money(quote.discount) }}</span>
          </div>
          <div>
            <span
              >配送费{{
                quote.shipping ? ` · ${quote.shipping.name}` : ""
              }}</span
            ><span>{{ money(quote.shippingFee ?? 0) }}</span>
          </div>
          <div class="summary-total">
            <span>应付金额</span><strong>{{ money(quote.total) }}</strong>
          </div>
          <p class="secondary">
            报价有效至
            {{ dateTime(quote.expiresAt) }}。报价不占库存，提交订单后预占 30
            分钟。
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
            submitting ||
            quoting ||
            saving ||
            editing ||
            !quote ||
            expired ||
            stale ||
            !!selectedCouponReason ||
            disconnected
          "
          @click="submit"
        >
          {{ submitting ? "正在提交…" : "提交订单" }}</button
        ><button
          class="text-link"
          :disabled="submitting || quoting || !addressId || disconnected"
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
