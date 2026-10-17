<script setup lang="ts">
import { computed, reactive } from "vue";
import { useShop } from "../../stores/shop";
import { afterSaleLabels, dateTime, money } from "../../domain/types";
import { api } from "../../services/api";
import ActionNotice from "../../components/shop/ActionNotice.vue";
import { useAction } from "../../components/shop/useAction";
import "../../styles/commerce-flow.css";
import { eventLabel } from "../../components/shop/commerceLabels";
const shop = useShop(),
  { busy, error, notice, run } = useAction(),
  records = computed(() =>
    [...shop.db.afterSales]
      .filter((a) => a.userId === shop.userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  );
const returns = reactive<Record<string, { carrier: string; tracking: string }>>(
  {},
);
function returnForm(id: string) {
  return returns[id] ?? (returns[id] = { carrier: "模拟快递", tracking: "" });
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
function submitReturn(id: string) {
  const input = returnForm(id);
  return run(
    () => api.submitReturn(id, input.carrier, input.tracking),
    "退货单号已提交，等待管理员确认收货",
  );
}
</script>
<template>
  <div class="page-wrap">
    <div class="page-heading">
      <h1>售后服务</h1>
      <p>每一笔申请，都可以在这里查看进度。</p>
    </div>
    <ActionNotice :error="error" :notice="notice" />
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
        <p
          v-if="a.status === 'approved' && a.requiresReturn"
          class="action-notice"
        >
          退货申请已批准。请填写模拟承运商与单号，管理员确认收货后退款，无需实际寄件。
        </p>
        <form
          v-if="a.status === 'approved' && a.requiresReturn"
          class="form-stack"
          @submit.prevent="submitReturn(a.id)"
        >
          <div class="form-two">
            <label
              >模拟退货承运商<input
                v-model.trim="returnForm(a.id).carrier"
                required
                maxlength="40" /></label
            ><label
              >模拟退货单号<input
                v-model.trim="returnForm(a.id).tracking"
                required
                maxlength="80"
                minlength="3"
            /></label>
          </div>
          <button class="button" :disabled="busy">提交退货单号</button>
        </form>
        <p v-if="a.returnTracking">
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
            v-if="['requested', 'approved'].includes(a.status)"
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
            :to="{ path: '/support', query: { orderId: a.orderId } }"
            class="text-link"
            >咨询进度</RouterLink
          >
        </div>
      </article>
    </div>
    <div v-else class="empty-state">
      <h2>暂无售后记录</h2>
      <p>需要退货或退款时，从对应订单发起申请。</p>
      <RouterLink to="/orders" class="button">查看我的订单</RouterLink>
    </div>
  </div>
</template>
