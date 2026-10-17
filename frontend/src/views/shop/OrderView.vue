<script setup lang="ts">
import { computed, ref, reactive, watch } from "vue";
import { useRoute } from "vue-router";
import { useShop } from "../../stores/shop";
import { api } from "../../services/api";
import {
  money,
  dateTime,
  orderLabels,
  afterSaleLabels,
} from "../../domain/types";
import OrderItems from "../../components/shop/OrderItems.vue";
import ActionNotice from "../../components/shop/ActionNotice.vue";
import { useAction } from "../../components/shop/useAction";
import "../../styles/commerce-flow.css";
import { eventLabel } from "../../components/shop/commerceLabels";
const shop = useShop(),
  route = useRoute(),
  order = computed(() => shop.myOrders.find((o) => o.id === route.params.id)),
  afterSale = computed(
    () =>
      [...shop.db.afterSales]
        .filter(
          (a) => a.orderId === order.value?.id && a.userId === shop.userId,
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0],
  ),
  showForm = ref(false),
  reason = ref("不再需要"),
  description = ref(""),
  { busy, error, notice, run } = useAction();
const activeAfterSale = computed(() =>
  shop.db.afterSales.some(
    (a) =>
      a.orderId === order.value?.id &&
      ["requested", "approved", "returning", "received"].includes(a.status),
  ),
);
const quantities = reactive<Record<string, number>>({});
const remaining = computed(
  () => order.value?.items.filter((i) => i.quantity > i.refundedQuantity) ?? [],
);
function toggleAfterSale() {
  showForm.value = !showForm.value;
  if (showForm.value) {
    for (const i of remaining.value)
      quantities[i.id] = i.quantity - i.refundedQuantity;
  }
}
watch(
  () => order.value?.id,
  () => {
    for (const i of order.value?.items ?? [])
      quantities[i.id] = i.quantity - i.refundedQuantity;
  },
  { immediate: true },
);
async function reorder() {
  let message = "";
  if (
    order.value &&
    (await run(async () => {
      const result = await api.reorder(order.value!.id);
      message = `已加入 ${result.added} 件${result.skipped.length ? `；无法加入：${result.skipped.join("、")}` : "，请到购物车确认最新价格和库存。"}`;
    }))
  )
    notice.value = message;
}
function confirm() {
  if (order.value)
    return run(() => api.confirmOrder(order.value!.id), "已确认收货");
}
async function cancel() {
  if (order.value && window.confirm("确认取消这笔待付款订单？"))
    await run(() => api.cancelOrder(order.value!.id), "订单已取消");
}
async function request() {
  if (
    order.value &&
    (await run(
      () =>
        api.requestAfterSale(
          order.value!.id,
          reason.value,
          description.value,
          remaining.value
            .filter((i) => (quantities[i.id] ?? 0) > 0)
            .map((i) => ({ orderItemId: i.id, quantity: quantities[i.id]! })),
        ),
      "售后申请已提交，可在售后页面查看进度。",
    ))
  )
    showForm.value = false;
}
</script>
<template>
  <div v-if="order" class="page-wrap">
    <nav class="breadcrumb">
      <RouterLink to="/orders">我的订单</RouterLink><span>/</span
      ><span>订单详情</span>
    </nav>
    <div class="page-heading">
      <h1>{{ orderLabels[order.status] }}</h1>
      <p>订单 {{ order.id }} · {{ dateTime(order.createdAt) }}</p>
    </div>
    <ActionNotice :error="error" :notice="notice" />
    <p
      v-if="order.status === 'pending' && order.expiresAt"
      class="action-notice"
    >
      请在 {{ dateTime(order.expiresAt) }} 前完成模拟付款，超时自动取消。
    </p>
    <p v-if="order.cancelReason" class="secondary">
      关闭原因：{{ order.cancelReason }}
    </p>
    <div class="order-detail-layout">
      <div>
        <section class="checkout-section">
          <h2>商品明细</h2>
          <OrderItems :items="order.items" />
          <div class="order-detail-total">
            共 {{ order.items.reduce((n, i) => n + i.quantity, 0) }} 件，合计
            <strong>{{ money(order.total) }}</strong>
          </div>
          <p v-if="order.discount">
            商品原价 {{ money(order.subtotal) }} · 优惠
            {{ money(order.discount)
            }}{{ order.coupon ? `（${order.coupon.name}）` : "" }}
          </p>
          <p v-if="order.refundedAmount" class="commerce-amount-note">
            已退款 {{ money(order.refundedAmount) }}，剩余实付
            {{ money(order.total - order.refundedAmount) }}
          </p>
          <p
            v-for="i in order.items.filter((i) => i.refundedQuantity > 0)"
            :key="i.id"
            class="secondary"
          >
            {{ i.name }} · {{ i.skuName }} 已退 {{ i.refundedQuantity }} /
            {{ i.quantity }} 件
          </p>
        </section>
        <section v-if="order.events.length" class="checkout-section">
          <h2>订单进度</h2>
          <ol class="commerce-timeline">
            <li v-for="(event, index) in order.events" :key="index">
              <strong>{{ eventLabel(event.action) }}</strong
              ><span v-if="event.note"> · {{ event.note }}</span
              ><time
                >{{ dateTime(event.at) }} ·
                {{
                  event.actor === "admin"
                    ? "管理员"
                    : event.actor === "user"
                      ? "用户"
                      : "系统"
                }}</time
              >
            </li>
          </ol>
        </section>
        <section class="checkout-section">
          <h2>收货信息</h2>
          <p>{{ order.address.name }} · {{ order.address.phone }}</p>
          <p>{{ order.address.region }} {{ order.address.detail }}</p>
        </section>
        <section v-if="order.carrier" class="checkout-section">
          <h2>模拟物流</h2>
          <p>{{ order.carrier }} · {{ order.tracking }}</p>
          <p class="secondary">
            {{ order.shippedAt ? dateTime(order.shippedAt) : "" }}
            已模拟发货。本页面不提供真实物流轨迹。
          </p>
        </section>
        <section v-if="afterSale" class="checkout-section">
          <h2>售后进度</h2>
          <p>
            {{ afterSaleLabels[afterSale.status] }} · {{ afterSale.reason }}
          </p>
          <p>{{ afterSale.description }}</p>
          <p v-if="afterSale.note" class="secondary">
            处理说明：{{ afterSale.note }}
          </p>
          <RouterLink to="/after-sales" class="text-link"
            >查看售后记录</RouterLink
          >
        </section>
        <form
          v-if="showForm"
          class="checkout-section form-stack"
          data-ui
          @submit.prevent="request"
        >
          <h2>申请售后</h2>
          <p class="secondary">
            选择本次申请数量；不申请的商品填写 0。退款以原订单实付分摊金额为准。
          </p>
          <label v-for="i in remaining" :key="i.id" class="after-sale-line"
            ><span
              >{{ i.name }} · {{ i.skuName
              }}<small class="secondary"
                >（可申请 {{ i.quantity - i.refundedQuantity }} 件）</small
              ></span
            ><input
              v-model.number="quantities[i.id]"
              type="number"
              :aria-label="`${i.name} 售后数量`"
              required
              min="0"
              :max="i.quantity - i.refundedQuantity"
              step="1"
          /></label>
          <p>
            {{
              order.status === "paid"
                ? "未发货订单审核通过后可退款。"
                : "已发货订单需审核通过并确认退货收货后退款。"
            }}
          </p>
          <label
            >售后原因<select v-model="reason">
              <option>不再需要</option>
              <option>商品质量问题</option>
              <option>规格不合适</option>
              <option>其他原因</option>
            </select></label
          ><label
            >问题说明<textarea
              v-model="description"
              required
              minlength="3"
              maxlength="500"
              rows="4"
              placeholder="请说明具体情况，至少 3 个字"
            ></textarea>
          </label>
          <div class="button-row">
            <button
              class="button"
              :disabled="
                busy || !remaining.some((i) => (quantities[i.id] ?? 0) > 0)
              "
            >
              提交申请</button
            ><button type="button" @click="showForm = false">暂不申请</button>
          </div>
        </form>
      </div>
      <aside class="order-summary">
        <h2>订单操作</h2>
        <template v-if="order.status === 'pending'"
          ><RouterLink :to="`/orders/${order.id}/pay`" class="button"
            >模拟支付</RouterLink
          ><button :disabled="busy" class="text-link" @click="cancel">
            取消订单
          </button></template
        ><button
          v-if="order.status === 'shipped'"
          class="button"
          :disabled="busy || activeAfterSale"
          @click="confirm()"
        >
          确认收货</button
        ><button
          v-if="
            ['paid', 'shipped', 'completed'].includes(order.status) &&
            !activeAfterSale &&
            remaining.length > 0
          "
          class="button secondary-button"
          @click="toggleAfterSale"
        >
          申请售后</button
        ><RouterLink
          :to="{ path: '/support', query: { orderId: order.id } }"
          class="button secondary-button"
          >咨询这笔订单</RouterLink
        >
        <button
          :disabled="busy"
          class="button secondary-button"
          @click="reorder"
        >
          再次购买
        </button>
        <RouterLink
          v-if="order.status === 'completed'"
          to="/account?section=reviews"
          class="button secondary-button"
          >评价商品</RouterLink
        >
        <p class="secondary">付款、物流和退款均为演示，不产生真实资金流动。</p>
      </aside>
    </div>
  </div>
  <div v-else class="empty-state">
    <h1>没有找到该订单</h1>
    <p>请使用下单账号登录后查看。</p>
    <RouterLink to="/orders" class="button">我的订单</RouterLink>
  </div>
</template>
