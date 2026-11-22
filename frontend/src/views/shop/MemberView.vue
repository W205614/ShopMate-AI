<script setup lang="ts">
import { computed, ref, watch, onUnmounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useShop } from "../../stores/shop";
import { commerceAction, getCollectionPage } from "../../services/api";
import { request } from "../../services/repository";
import { dateTime } from "../../domain/types";
import { useAction } from "../../components/shop/useAction";
import ActionNotice from "../../components/shop/ActionNotice.vue";
import "../../styles/account-commerce.css";
import type { Notification } from "../../../../shared/domain/operations";
const shop = useShop(),
  route = useRoute(),
  router = useRouter();
const points = computed(() => route.path === "/points"),
  balance = ref<number | null>(null);
const { busy, error, notice, run } = useAction();
const metadata = computed(() => {
  void shop.db.revision;
  return getCollectionPage(points.value ? "pointsEntries" : "notifications");
});
let sequence = 0;
watch(
  () => shop.userId,
  () => {
    balance.value = null;
    sequence++;
  },
  { flush: "sync" },
);
onUnmounted(() => {
  sequence++;
});
watch(
  [points, () => shop.db.revision, () => shop.userId],
  async () => {
    const current = ++sequence,
      owner = shop.userId;
    if (!owner || !points.value) {
      balance.value = null;
      return;
    }
    if (points.value) {
      try {
        const result = (
          await request<{ balance: number }>("/api/member/points")
        ).balance;
        if (current === sequence && owner === shop.userId && points.value)
          balance.value = result;
      } catch {
        if (current === sequence) balance.value = null;
      }
    }
  },
  { immediate: true },
);
function page(value: number) {
  void router.push({
    path: route.path,
    query: value > 1 ? { page: String(value) } : {},
  });
}
function destination(item: Notification) {
  if (item.conversationId)
    return { path: "/support", query: { conversationId: item.conversationId } };
  if (item.afterSaleId)
    return { path: "/after-sales", query: { id: item.afterSaleId } };
  if (item.orderId) return `/orders/${item.orderId}`;
}
function openNotice(item: Notification) {
  return run(async () => {
    if (!item.read) await commerceAction("markNotificationRead", item.id);
    const target = destination(item);
    if (target) await router.push(target);
  });
}
</script>
<template>
  <div class="page-wrap">
    <div class="page-heading">
      <h1>{{ points ? "会员积分" : "站内通知" }}</h1>
      <p v-if="points">
        可用积分：{{ balance ?? "暂未读取" }}。确认收货按商品实付每满 1 元累计 1
        分，退款冲回；积分暂不可抵现。
      </p>
      <p v-else>查看订单、售后与退款动态。</p>
    </div>
    <ActionNotice :error="error" :notice="notice" />
    <div v-if="points" class="commerce-list">
      <article
        v-for="entry in shop.db.pointsEntries ?? []"
        :key="entry.id"
        class="commerce-list-card"
      >
        <p>
          {{ entry.reason }} · {{ entry.delta > 0 ? "+" : ""
          }}{{ entry.delta }} 分
        </p>
        <small>{{ dateTime(entry.createdAt) }}</small>
        <RouterLink :to="`/orders/${entry.orderId}`">查看订单</RouterLink>
      </article>
    </div>
    <div v-else class="commerce-list">
      <article
        v-for="item in shop.db.notifications ?? []"
        :key="item.id"
        class="commerce-list-card"
      >
        <p>
          <strong v-if="item.actionRequired">需要操作 · </strong>{{ item.text }}
        </p>
        <small>{{ dateTime(item.createdAt) }}</small>
        <button
          v-if="item.conversationId || item.afterSaleId"
          type="button"
          class="text-link"
          :disabled="busy"
          @click="openNotice(item)"
        >
          {{ item.conversationId ? "查看客服回复" : "查看售后进度" }}
        </button>
        <RouterLink v-else-if="item.orderId" :to="`/orders/${item.orderId}`"
          >查看订单</RouterLink
        >
        <button
          v-if="!item.read && !item.conversationId && !item.afterSaleId"
          class="text-link"
          :disabled="busy"
          @click="
            run(
              () => commerceAction('markNotificationRead', item.id),
              '已标为已读',
            )
          "
        >
          标为已读</button
        ><span v-if="item.read"> 已读</span>
      </article>
    </div>
    <p v-if="!metadata?.total">暂无记录。</p>
    <div v-if="metadata && metadata.pages > 1" class="button-row">
      <button :disabled="metadata.page <= 1" @click="page(metadata.page - 1)">
        上一页</button
      ><span
        >{{ metadata.page }} / {{ metadata.pages }} · 共
        {{ metadata.total }} 条</span
      ><button
        :disabled="metadata.page >= metadata.pages"
        @click="page(metadata.page + 1)"
      >
        下一页
      </button>
    </div>
  </div>
</template>
