<script setup lang="ts">
import { computed, ref, watch, nextTick, onUnmounted } from "vue";
import { ElMessageBox } from "element-plus";
import { useShop } from "../../stores/shop";
import { api } from "../../services/api";
import { dateTime } from "../../domain/types";
import { useAdminAction } from "./useAdmin";
import { useAdminQuery } from "./useAdminList";
const shop = useShop(),
  { busy, pending, run } = useAdminAction(),
  filter = useAdminQuery().field("status", {
    values: ["bot", "waiting", "human", "closed"],
  }),
  selectedId = ref(""),
  drafts = ref<Record<string, string>>({}),
  confirming = ref(false),
  messageBox = ref<HTMLElement>();
let alive = true,
  ownerEpoch = 0,
  cancelConfirmation: (() => void) | undefined;
watch(
  () => shop.adminSession?.id,
  () => {
    ownerEpoch++;
    drafts.value = {};
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
    bot: "模拟客服中",
    waiting: "等待人工",
    human: "人工接待中",
    closed: "已关闭",
  },
  roles = { user: "用户", assistant: "模拟客服", agent: "人工客服" };
const conversations = computed(() =>
  [...shop.db.conversations]
    .filter((c) => !filter.value || c.status === filter.value)
    .sort((a, b) => {
      if (a.status === "waiting" && b.status !== "waiting") return -1;
      if (b.status === "waiting" && a.status !== "waiting") return 1;
      return b.createdAt.localeCompare(a.createdAt);
    }),
);
const selected = computed(() =>
  conversations.value.find((c) => c.id === selectedId.value),
);
const text = computed({
  get: () => (selected.value ? (drafts.value[selected.value.id] ?? "") : ""),
  set: (value) => {
    if (selected.value) drafts.value[selected.value.id] = value;
  },
});
watch(
  [() => selected.value?.id, () => selected.value?.status, filter],
  () => cancelConfirmation?.(),
  { flush: "sync" },
);
watch(
  conversations,
  (list) => {
    if (!list.some((c) => c.id === selectedId.value))
      selectedId.value = list[0]?.id ?? "";
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
        v-for="c in conversations"
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
    </aside>
    <section class="admin-chat-body">
      <template v-if="selected"
        ><div class="admin-panel-head">
          <div>
            <h2>{{ selected.title }}</h2>
            <span class="admin-note"
              >{{ labels[selected.status] }} ·
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
          此会话由模拟客服接待。用户转人工后，可在此回复。
        </p>
        <p v-else-if="selected.status === 'closed'" class="admin-note">
          {{
            text
              ? "会话已关闭，未发送草稿仅供复制。"
              : "会话已关闭，历史消息已保留。"
          }}
        </p></template
      ><el-empty v-else description="选择会话开始处理" :image-size="80" />
    </section>
  </div>
</template>
