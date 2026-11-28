<script setup lang="ts">
import { useCommerceMode } from "../../services/commerceMode";
const { production, loaded, error: modeError } = useCommerceMode();
import CollectionPager from "../../components/shop/CollectionPager.vue";
import { computed, reactive } from "vue";
import { useRoute } from "vue-router";
import { useShop } from "../../stores/shop";
import {
  afterSaleLabels,
  dateTime,
  money,
  type AfterSale,
} from "../../domain/types";
import { api } from "../../services/api";
import ActionNotice from "../../components/shop/ActionNotice.vue";
import { useAction } from "../../components/shop/useAction";
import "../../styles/commerce-flow.css";
import { eventLabel } from "../../components/shop/commerceLabels";
import { afterSaleState } from "../../domain/afterSaleState";
const shop = useShop(),
  { busy, error, notice, run } = useAction(),
  records = computed(() =>
    [...shop.db.afterSales]
      .filter((a) => a.userId === shop.userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  );
const route = useRoute();
const returns = reactive<Record<string, { carrier: string; tracking: string }>>(
  {},
);
function returnForm(id: string) {
  return (
    returns[id] ??
    (returns[id] = {
      carrier: production.value ? "顺丰速运" : "模拟快递",
      tracking: "",
    })
  );
}
function itemName(orderId: string, itemId: string) {
  const i = shop.myOrders
    .find((o) => o.id === orderId)
    ?.items.find((i) => i.id === itemId);
  return i ? `${i.name} · ${i.skuName}` : "历史订单商品";
}
async function cancel(id: string) {
  if (window.confirm("确认撤销售后申请？"))
    await run(
      () => api.cancelAfterSale(id),
      "售后申请已撤销，可重新选择商品数量申请",
    );
}
function submitReturn(id: string, parcelId?: string) {
  const input = returnForm(parcelId ?? id);
  return run(
    () =>
      parcelId
        ? api.submitReturn(id, input.carrier, input.tracking, parcelId)
        : api.submitReturn(id, input.carrier, input.tracking),
    "退货单号已提交，等待管理员确认收货",
  );
}
const refundStatus = {
  pending: "等待渠道处理",
  unknown: "等待渠道核对",
  processing: "渠道处理中",
  succeeded: "渠道已确认退款",
  failed: "渠道退款失败，请联系商家核对",
  abnormal: "退款异常，请联系商家核对",
};
function guidance(sale: AfterSale) {
  const order = shop.myOrders.find((o) => o.id === sale.orderId);
  if (
    sale.status === "approved" &&
    sale.requiresReturn &&
    order?.transactionMode === "production"
  )
    return sale.returnAddress
      ? "请按下方地址寄回商品，寄出后提交退货单号。"
      : "请先咨询客服确认寄回信息，寄出后再提交退货单号。";
  return afterSaleState(sale, order).guidance;
}
function copyAddress(address: string) {
  return run(() => navigator.clipboard.writeText(address), "退货地址已复制");
}
</script>
<template>
  <div class="page-wrap">
    <div class="page-heading">
      <h1>售后服务</h1>
      <p>每一笔申请，都可以在这里查看进度。</p>
    </div>
    <ActionNotice :error="error || modeError" :notice="notice" />
    <RouterLink v-if="route.query.id" to="/after-sales" class="text-link"
      >查看全部售后</RouterLink
    >
    <div class="after-sale-explainer">
      <h2>需要帮助？</h2>
      <p>
        从订单详情发起售后。未发货订单审核后退款；已发货订单按退货流程处理，管理端确认收货后退款。
      </p>
      <RouterLink to="/orders" class="text-link">选择需要售后的订单</RouterLink>
    </div>
    <div v-if="records.length" class="orders-list">
      <article v-for="a in records" :key="a.id" class="order-block">
        <div class="order-top">
          <div>
            <strong>{{ a.reason }}</strong
            ><span class="secondary">{{ dateTime(a.createdAt) }}</span>
          </div>
          <strong class="order-status">{{ afterSaleLabels[a.status] }}</strong>
        </div>
        <p>{{ a.description }}</p>
        <p class="secondary">售后编号 {{ a.id }}</p>
        <p class="secondary">
          {{ a.requiresReturn ? "退货退款" : "仅退款" }} · 订单
          {{ a.orderId }} · 本次退款 {{ money(a.refundAmount) }}
        </p>
        <ul>
          <li v-for="line in a.lines" :key="line.orderItemId">
            {{ itemName(a.orderId, line.orderItemId) }} × {{ line.quantity }} ·
            {{ money(line.amount) }}
          </li>
        </ul>
        <p v-if="a.note">处理说明：{{ a.note }}</p>
        <p v-if="a.events.at(-1)" class="secondary">
          最新进度：{{ eventLabel(a.events.at(-1)!.action) }} ·
          {{ dateTime(a.events.at(-1)!.at) }}
        </p>
        <p class="action-notice">{{ guidance(a) }}</p>
        <p v-if="a.channelRefund">
          {{ money(a.channelRefund.amount) }} ·
          {{
            a.channelRefund.noTransfer
              ? "无需资金退回"
              : a.channelRefund.provider === "wechatpay"
                ? "原微信支付渠道"
                : "原支付宝渠道"
          }}
          ·
          {{
            a.channelRefund.noTransfer && a.channelRefund.status === "succeeded"
              ? "已处理"
              : refundStatus[a.channelRefund.status]
          }}
        </p>
        <section
          v-if="
            a.returnParcels?.length &&
            ['approved', 'returning', 'received', 'refunded'].includes(a.status)
          "
        >
          <div
            v-for="(parcel, index) in a.returnParcels"
            :key="parcel.id"
            class="checkout-section"
          >
            <h3>退货包裹 {{ index + 1 }}</h3>
            <p v-if="parcel.tracking">
              {{ parcel.carrier }} · {{ parcel.tracking }} ·
              {{ parcel.receivedAt ? "已收货" : "待商家收货" }}
            </p>
            <form
              v-else-if="loaded"
              class="form-stack"
              @submit.prevent="submitReturn(a.id, parcel.id)"
            >
              <div v-if="parcel.address">
                <strong>寄回地址</strong>
                <p>{{ parcel.address }}</p>
                <button
                  type="button"
                  class="text-link"
                  :disabled="busy"
                  @click="copyAddress(parcel.address)"
                >
                  复制退货地址
                </button>
              </div>
              <div class="form-two">
                <label
                  >{{ production ? "退货承运商" : "模拟退货承运商" }}
                  <input
                    v-model.trim="returnForm(parcel.id).carrier"
                    required
                    maxlength="60"
                  />
                </label>
                <label
                  >{{ production ? "退货单号" : "模拟退货单号" }}
                  <input
                    v-model.trim="returnForm(parcel.id).tracking"
                    required
                    maxlength="80"
                  />
                </label>
              </div>
              <button class="button" :disabled="busy">提交退货单号</button>
            </form>
          </div>
        </section>
        <form
          v-if="
            loaded &&
            !a.returnParcels?.length &&
            afterSaleState(
              a,
              shop.myOrders.find((o) => o.id === a.orderId),
            ).canReturn
          "
          class="form-stack"
          @submit.prevent="submitReturn(a.id)"
        >
          <div v-if="a.returnAddress">
            <strong>寄回地址</strong>
            <p>{{ a.returnAddress }}</p>
            <button
              type="button"
              class="text-link"
              :disabled="busy"
              @click="copyAddress(a.returnAddress)"
            >
              复制退货地址
            </button>
          </div>
          <p>退货寄件运费由顾客承担。寄出后请提交承运商和单号。</p>
          <div class="form-two">
            <label
              >{{ production ? "退货承运商" : "模拟退货承运商"
              }}<input
                v-model.trim="returnForm(a.id).carrier"
                required
                maxlength="60" /></label
            ><label
              >{{ production ? "退货单号" : "模拟退货单号"
              }}<input
                v-model.trim="returnForm(a.id).tracking"
                required
                maxlength="80"
                minlength="1"
            /></label>
          </div>
          <button class="button" :disabled="busy">提交退货单号</button>
        </form>
        <p v-if="a.returnTracking && !a.returnParcels?.length">
          退货物流：{{ a.returnCarrier }} · {{ a.returnTracking }}
        </p>
        <details v-if="a.events.length">
          <summary>处理记录</summary>
          <ol class="commerce-timeline">
            <li v-for="(event, index) in a.events" :key="index">
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
        </details>
        <div class="button-row">
          <button
            v-if="
              afterSaleState(
                a,
                shop.myOrders.find((o) => o.id === a.orderId),
              ).canCancel
            "
            :disabled="busy"
            @click="cancel(a.id)"
          >
            撤销申请
          </button>
          <RouterLink
            :to="`/orders/${a.orderId}`"
            class="button secondary-button"
            >查看订单</RouterLink
          ><RouterLink
            :to="{
              path: '/support',
              query: { orderId: a.orderId, afterSaleId: a.id },
            }"
            class="text-link"
            >{{
              a.channelRefund &&
              ["failed", "abnormal", "unknown"].includes(a.channelRefund.status)
                ? "联系客服核对退款"
                : "咨询进度"
            }}</RouterLink
          >
        </div>
      </article>
    </div>
    <div v-else class="empty-state">
      <h2>{{ route.query.id ? "找不到这笔售后记录" : "暂无售后记录" }}</h2>
      <p>需要退货或退款时，从对应订单发起申请。</p>
      <RouterLink to="/orders" class="button">查看我的订单</RouterLink>
    </div>
    <CollectionPager />
  </div>
</template>
