<script setup lang="ts">
import { computed, ref, watch, nextTick, onUnmounted } from "vue";
import { ElMessageBox } from "element-plus";
import { useShop } from "../../stores/shop";
import { api } from "../../services/api";
import { request } from "../../services/repository";
import { dateTime } from "../../domain/types";
import { useAdminAction } from "./useAdmin";
import { useAdminQuery, useAdminPagination } from "./useAdminList";
const shop = useShop(),
  { busy, pending, run } = useAdminAction(),
  filters = useAdminQuery(),
  statusField = filters.field("status", {
    values: ["bot", "waiting", "human", "closed"],
  }),
  queryField = filters.field("q", { replace: true }),
  detailId = filters.field("detail", { resetPage: false }),
  autoSelectedId = ref(""),
  drafts = ref<Record<string, string>>({}),
  confirming = ref(false),
  messageBox = ref<HTMLElement>();
const filter = computed({
  get: () => statusField.value,
  set: (value) => {
    void filters
      .update({ status: value, detail: "" }, { resetPage: true })
      .catch(() => undefined);
  },
});
const query = computed({
  get: () => queryField.value,
  set: (value) => {
    void filters
      .update({ q: value, detail: "" }, { resetPage: true, replace: true })
      .catch(() => undefined);
  },
});
const selectedId = computed({
  get: () => detailId.value || autoSelectedId.value,
  set: (value) => {
    detailId.value = value;
  },
});
let alive = true,
  ownerEpoch = 0,
  cancelConfirmation: (() => void) | undefined;
watch(
  () => shop.adminSession?.id,
  () => {
    ownerEpoch++;
    drafts.value = {};
    autoSelectedId.value = "";
    selectedId.value = "";
    cancelConfirmation?.();
  },
  { flush: "sync" },
);
onUnmounted(() => {
  alive = false;
  cancelConfirmation?.();
});
const labels = {
    bot: "自动客服中",
    waiting: "等待人工",
    human: "人工接待中",
    closed: "已关闭",
  },
  roles = { user: "用户", assistant: "自动客服", agent: "人工客服" };
const allConversations = computed(() =>
  [...shop.db.conversations].sort((a, b) => {
    const priority = { waiting: 0, human: 1, bot: 2, closed: 3 };
    return (
      priority[a.status] - priority[b.status] ||
      b.createdAt.localeCompare(a.createdAt) ||
      b.id.localeCompare(a.id)
    );
  }),
);
const conversations = computed(() =>
  allConversations.value.filter(
    (c) =>
      (!filter.value || c.status === filter.value) &&
      (!query.value.trim() ||
        [
          c.id,
          c.title,
          c.orderId ?? "",
          shop.db.users.find((u) => u.id === c.userId)?.name ?? "",
        ].some((value) =>
          value.toLowerCase().includes(query.value.trim().toLowerCase()),
        )),
  ),
);
const {
  page: storedPage,
  rows: visibleConversations,
  total,
} = useAdminPagination(conversations, filters);
const page = computed({
  get: () => storedPage.value,
  set: (value) => {
    void filters
      .update({ page: value > 1 ? String(value) : "", detail: "" })
      .catch(() => undefined);
  },
});
const selected = computed(() =>
  conversations.value.find((c) => c.id === selectedId.value),
);
const target = computed(() =>
  shop.db.conversations.find((c) => c.id === detailId.value),
);
async function locate() {
  const id = selectedId.value;
  if (!id) return;
  await run(async () => {
    const result = await request<{ page: number; located: boolean }>(
      `/api/collections/conversations?role=admin&locate=${encodeURIComponent(id)}&pageSize=10`,
    );
    if (!result.located) throw new Error("目标会话已不存在，请重新读取列表");
    await filters.update({
      q: "",
      status: "",
      page: result.page > 1 ? String(result.page) : "",
      detail: id,
    });
  }, "已定位会话");
}
const text = computed({
  get: () => (selected.value ? (drafts.value[selected.value.id] ?? "") : ""),
  set: (value) => {
    if (selected.value) drafts.value[selected.value.id] = value;
  },
});
watch(
  [() => selected.value?.id, () => selected.value?.status, filter, query, page],
  () => cancelConfirmation?.(),
  { flush: "sync" },
);
watch(
  visibleConversations,
  (list) => {
    if (!list.some((c) => c.id === autoSelectedId.value))
      autoSelectedId.value = list[0]?.id ?? "";
  },
  { immediate: true },
);
watch(
  [() => selected.value?.id, () => selected.value?.messages.length],
  async () => {
    await nextTick();
    if (messageBox.value)
      messageBox.value.scrollTop = messageBox.value.scrollHeight;
  },
);
async function reply() {
  const conversation = selected.value,
    raw = text.value,
    owner = shop.adminSession?.id,
    epoch = ownerEpoch;
  if (
    busy.value ||
    !conversation ||
    !["waiting", "human"].includes(conversation.status) ||
    !raw.trim()
  )
    return;
  if (
    (await run(
      () => api.replyConversation(conversation.id, raw.trim()),
      "回复已发送",
    )) &&
    alive &&
    owner === shop.adminSession?.id &&
    epoch === ownerEpoch &&
    drafts.value[conversation.id] === raw
  )
    delete drafts.value[conversation.id];
}
async function close() {
  const conversation = selected.value,
    owner = shop.adminSession?.id,
    epoch = ownerEpoch;
  if (
    busy.value ||
    confirming.value ||
    !conversation ||
    conversation.status === "closed"
  )
    return;
  confirming.value = true;
  try {
    const confirmed = await Promise.race([
      ElMessageBox.confirm(
        `确认关闭「${conversation.title}」（${conversation.id}）？用户可重新发起咨询。`,
        "关闭会话",
      ).then(() => true),
      new Promise<boolean>((resolve) => {
        cancelConfirmation = () => {
          ElMessageBox.close();
          resolve(false);
        };
      }),
    ]);
    cancelConfirmation = undefined;
    if (
      !confirmed ||
      !alive ||
      owner !== shop.adminSession?.id ||
      epoch !== ownerEpoch ||
      selected.value?.id !== conversation.id ||
      selected.value.status !== conversation.status
    )
      return;
    await run(() => api.closeConversation(conversation.id), "会话已关闭");
  } catch {
    /* dismissed */
  } finally {
    confirming.value = false;
    cancelConfirmation = undefined;
  }
}
</script>
<template>
  <div class="admin-page-head">
    <div>
      <h1>客服工作台</h1>
      <p>接住每一个问题，让咨询有回应。</p>
    </div>
    <el-tag effect="plain">服务端同步会话</el-tag>
  </div>
  <div class="admin-chat" :class="{ 'is-empty': !selected }">
    <aside class="admin-chat-list">
      <el-input
        v-model="query"
        placeholder="搜索会话 / 用户 / 商品 / 订单"
        clearable
        style="margin-bottom: 12px"
      />
      <el-select
        v-model="filter"
        placeholder="全部会话"
        clearable
        style="width: 100%; margin-bottom: 16px"
        ><el-option
          v-for="(label, key) in labels"
          :key="key"
          :label="label"
          :value="key" /></el-select
      ><button
        v-for="c in visibleConversations"
        :key="c.id"
        class="admin-conversation"
        :class="{ active: c.id === selectedId }"
        @click="selectedId = c.id"
      >
        {{ c.title
        }}<span
          >{{ shop.db.users.find((u) => u.id === c.userId)?.name }} ·
          {{ labels[c.status] }}</span
        ><span>{{
          c.messages.at(-1)?.text.slice(0, 35) || "新会话"
        }}</span></button
      ><el-empty
        v-if="!conversations.length"
        description="暂无会话"
        :image-size="70"
      />
      <el-pagination
        v-model:current-page="page"
        size="small"
        :page-size="10"
        :total="total"
        layout="prev,pager,next"
      />
    </aside>
    <section class="admin-chat-body">
      <template v-if="selected"
        ><div class="admin-panel-head">
          <div>
            <h2>{{ selected.title }}</h2>
            <span class="admin-note"
              >{{ selected.id }} · {{ labels[selected.status] }} ·
              {{
                shop.db.users.find((u) => u.id === selected?.userId)?.name
              }}</span
            >
          </div>
          <el-button
            v-if="selected.status !== 'closed'"
            @click="close"
            :loading="pending"
            :disabled="busy || confirming"
            >关闭会话</el-button
          >
        </div>
        <div
          v-if="selected.productId || selected.orderId"
          class="admin-callout"
        >
          <template v-if="selected.productId"
            >关联商品：{{
              shop.db.products.find((p) => p.id === selected?.productId)?.name
            }}</template
          ><template v-if="selected.orderId"
            >关联订单：{{ selected.orderId }}</template
          >
        </div>
        <div class="admin-messages" ref="messageBox" aria-live="polite">
          <article
            class="admin-message"
            :class="m.role"
            v-for="m in selected.messages"
            :key="m.id"
          >
            <small>{{ roles[m.role] }} · {{ dateTime(m.createdAt) }}</small>
            <p>{{ m.text }}</p>
            <div v-if="m.productIds?.length" class="admin-note">
              推荐商品：{{
                m.productIds
                  .map((id) => shop.db.products.find((p) => p.id === id)?.name)
                  .join("、")
              }}
            </div>
            <div v-if="m.orderId" class="admin-note">订单：{{ m.orderId }}</div>
          </article>
        </div>
        <el-button
          v-if="!visibleConversations.some((c) => c.id === selected?.id)"
          link
          @click="locate"
          >定位到该会话页</el-button
        >
        <div
          v-if="['waiting', 'human'].includes(selected.status) || text"
          class="admin-compose"
        >
          <el-input
            v-model="text"
            type="textarea"
            :rows="3"
            maxlength="1000"
            placeholder="输入人工回复。发送后会话转为人工接待。"
            :readonly="!['waiting', 'human'].includes(selected.status)"
            @keydown.ctrl.enter.prevent="reply"
          /><el-button
            v-if="['waiting', 'human'].includes(selected.status)"
            type="primary"
            :loading="pending"
            :disabled="busy || !text.trim()"
            @click="reply"
            >发送回复</el-button
          >
        </div>
        <p v-if="selected.status === 'bot'" class="admin-note">
          此会话由自动客服接待。用户转人工后，可在此回复。
        </p>
        <p v-else-if="selected.status === 'closed'" class="admin-note">
          {{
            text
              ? "会话已关闭，未发送草稿仅供复制。"
              : "会话已关闭，历史消息已保留。"
          }}
        </p></template
      >
      <div v-else-if="detailId">
        <el-alert
          :title="target ? '目标会话不符合当前筛选' : '没有找到该会话'"
          type="warning"
          :closable="false"
        /><el-button v-if="target" @click="locate">清除筛选并定位</el-button>
      </div>
      <el-empty v-else description="选择会话开始处理" :image-size="80" />
    </section>
  </div>
</template>
