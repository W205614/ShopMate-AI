<script setup lang="ts">
import CollectionPager from "../../components/shop/CollectionPager.vue";
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  Send,
  Plus,
  ArrowUpRight,
  UserRound,
  MessageCircle,
} from "lucide-vue-next";
import { useShop } from "../../stores/shop";
import { api, commerceAction } from "../../services/api";
import { request } from "../../services/repository";
import {
  activeSupportRun,
  getSupportDetail,
  supportPhase,
  supportFailure,
  supportDegradation,
} from "../../services/support";
import type { SupportDetail } from "../../services/support";
import { dateTime, orderLabels, money } from "../../domain/types";
import ProductCard from "../../components/shop/ProductCard.vue";
import ActionNotice from "../../components/shop/ActionNotice.vue";
import { useAction } from "../../components/shop/useAction";
const shop = useShop(),
  route = useRoute(),
  router = useRouter(),
  activeId = ref(""),
  drafts = ref<Record<string, string>>({}),
  detail = ref<SupportDetail | null>(null),
  aiEnabled = ref<boolean | null>(null),
  detailError = ref(""),
  messagesEl = ref<HTMLElement>(),
  { busy, pending, error, notice, run } = useAction();
let alive = true,
  epoch = 0,
  readSequence = 0,
  timer: ReturnType<typeof setTimeout> | undefined;
let draftVersions: Record<string, number> = {};
const text = computed({
  get: () => drafts.value[activeId.value] ?? "",
  set: (value: string) => {
    drafts.value[activeId.value] = value;
    draftVersions[activeId.value] = (draftVersions[activeId.value] ?? 0) + 1;
  },
});
const conversations = computed(() =>
    shop.db.conversations
      .filter((c) => c.userId === shop.userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  ),
  conversation = computed(() =>
    detail.value?.conversation.id === activeId.value
      ? detail.value.conversation
      : conversations.value.find((c) => c.id === activeId.value),
  ),
  products = computed(() => [
    ...(detail.value?.products ?? []),
    ...shop.db.products,
  ]),
  orders = computed(() => [...(detail.value?.orders ?? []), ...shop.myOrders]),
  product = computed(() =>
    products.value.find((p) => p.id === conversation.value?.productId),
  ),
  order = computed(() =>
    orders.value.find((o) => o.id === conversation.value?.orderId),
  ),
  generating = computed(() => activeSupportRun(detail.value?.run)),
  statusLabels = computed(() => ({
    bot: aiEnabled.value
      ? "AI 客服"
      : aiEnabled.value === false
        ? "规则客服"
        : "在线客服",
    waiting: "等待人工接入",
    human: "人工服务中",
    closed: "会话已结束",
  }));
const capture = () => ({
  epoch,
  actor: shop.userSession?.id,
  id: activeId.value,
});
const current = (target: ReturnType<typeof capture>) =>
  alive &&
  target.epoch === epoch &&
  target.actor === shop.userSession?.id &&
  target.id === activeId.value;
function stopPolling() {
  clearTimeout(timer);
  timer = undefined;
}
function shouldPoll(value: SupportDetail | null) {
  return (
    !!value &&
    value.conversation.status !== "closed" &&
    (activeSupportRun(value.run) ||
      value.conversation.status === "waiting" ||
      value.conversation.status === "human")
  );
}
async function refreshDetail() {
  stopPolling();
  const target = capture(),
    sequence = ++readSequence;
  if (!target.id || !target.actor) return;
  try {
    const value = await getSupportDetail(target.id);
    if (!current(target) || sequence !== readSequence) return;
    if (
      value.conversation.id !== target.id ||
      value.conversation.userId !== target.actor
    )
      throw Error("会话身份不匹配，请重新读取");
    detail.value = value;
    aiEnabled.value = value.aiEnabled;
    detailError.value = "";
    if (shouldPoll(value)) timer = setTimeout(() => void refreshDetail(), 1200);
  } catch (e) {
    if (!current(target) || sequence !== readSequence) return;
    detailError.value = e instanceof Error ? e.message : "无法读取会话";
    // Resume a known active task after a transient read failure. No mutation is retried.
    if (shouldPoll(detail.value))
      timer = setTimeout(() => void refreshDetail(), 3000);
  }
}
async function select(id: string) {
  activeId.value = id;
  await router.replace({
    query: { ...route.query, conversationId: id || undefined },
  });
}
async function start(context?: { productId?: string; orderId?: string }) {
  if (!shop.user) {
    await router.push({ path: "/login", query: { redirect: route.fullPath } });
    return;
  }
  const target = capture();
  let created: string | undefined;
  await run(async () => {
    const id = context
      ? await api.createConversation(context)
      : await api.createConversation();
    if (current(target)) {
      await select(id);
      created = id;
    }
  });
  return created;
}
async function transfer() {
  const target = capture();
  if (
    await run(
      () => api.transferConversation(target.id),
      "已提交转人工，请等待客服接入。",
    )
  )
    if (current(target)) await refreshDetail();
}
async function proposalAction(id: string, confirm: boolean) {
  const target = capture();
  await run(
    () =>
      commerceAction(
        confirm ? "confirmSupportProposal" : "cancelSupportProposal",
        id,
      ),
    confirm ? "操作已完成，请核对最新记录。" : "已取消操作。",
  );
  if (current(target)) await refreshDetail();
}
async function retry() {
  const target = capture(),
    id = detail.value?.run?.id;
  if (id && (await run(() => commerceAction("retrySupportRun", id))))
    if (current(target)) await refreshDetail();
}
function proposalLines(details: Record<string, unknown>) {
  if (!Array.isArray(details.lines)) return [];
  const order = orders.value.find((o) => o.id === details.orderId);
  return details.lines.flatMap((line: unknown) => {
    if (
      !line ||
      typeof line !== "object" ||
      !("orderItemId" in line) ||
      !("quantity" in line) ||
      typeof line.quantity !== "number"
    )
      return [];
    const item = order?.items.find((i) => i.id === line.orderItemId);
    return [
      {
        id: String(line.orderItemId),
        title: item
          ? `${item.name} · ${item.skuName}`
          : `商品明细 ${String(line.orderItemId)}`,
        quantity: line.quantity,
      },
    ];
  });
}
async function initialize() {
  if (!shop.userSession?.id || !alive) return;
  const id = String(route.query.conversationId ?? "");
  if (id) {
    activeId.value = id;
    return;
  }
  const productId = String(route.query.productId ?? ""),
    orderId = String(route.query.orderId ?? "");
  if (productId || orderId) {
    const existing = conversations.value.find(
      (c) =>
        c.status !== "closed" &&
        c.productId === (productId || undefined) &&
        c.orderId === (orderId || undefined),
    );
    if (existing) await select(existing.id);
    else
      await start({
        productId: productId || undefined,
        orderId: orderId || undefined,
      });
  } else if (!activeId.value && conversations.value[0])
    await select(conversations.value[0].id);
}
watch(activeId, () => {
  stopPolling();
  readSequence++;
  detail.value = null;
  detailError.value = "";
  void refreshDetail();
});
watch(
  () => shop.userSession?.id,
  () => {
    epoch++;
    stopPolling();
    readSequence++;
    activeId.value = "";
    drafts.value = {};
    draftVersions = {};
    detail.value = null;
    detailError.value = "";
    error.value = "";
    notice.value = "";
    void initialize();
  },
  { flush: "sync" },
);
watch(() => route.query, initialize);
// Existing bootstrap synchronization carries human replies and closes even after AI polling ends.
watch(
  () => shop.db.conversations,
  () => {
    const item = conversations.value.find((c) => c.id === activeId.value),
      previous = detail.value?.conversation;
    if (
      item &&
      previous &&
      (item.messages.length > previous.messages.length ||
        (item.messages.length === previous.messages.length &&
          { bot: 0, waiting: 1, human: 2, closed: 3 }[item.status] >
            { bot: 0, waiting: 1, human: 2, closed: 3 }[previous.status]))
    )
      detail.value!.conversation = item;
  },
);
onMounted(async () => {
  const owner = epoch;
  try {
    const config = await request<{ aiEnabled: boolean }>("/api/support/config");
    if (alive && owner === epoch) aiEnabled.value = config.aiEnabled;
  } catch {
    /* Detail fetch can also provide the flag. */
  }
  await initialize();
});
onUnmounted(() => {
  alive = false;
  epoch++;
  stopPolling();
});
watch(
  () => conversation.value?.messages.length,
  async () => {
    await nextTick();
    messagesEl.value?.scrollTo({
      top: messagesEl.value.scrollHeight,
      behavior: "smooth",
    });
  },
);
async function send(value?: string) {
  const content = (value ?? text.value).trim();
  if (!content || generating.value || busy.value) return;
  if (!conversation.value) {
    if (!shop.user) {
      await router.push({ path: "/login", query: { redirect: "/support" } });
      return;
    }
    const oldDraft = text.value;
    const created = await start();
    if (!created || activeId.value !== created || !conversation.value) return;
    if (!text.value) text.value = oldDraft;
  }
  const target = capture(),
    sentDraft = text.value,
    draftVersion = draftVersions[target.id];
  if (await run(() => api.sendMessage(target.id, content))) {
    if (
      alive &&
      epoch === target.epoch &&
      target.actor === shop.userSession?.id &&
      draftVersions[target.id] === draftVersion &&
      (value === undefined || sentDraft.trim() === content)
    )
      drafts.value[target.id] = "";
    if (current(target)) await refreshDetail();
  }
}
</script>
<template>
  <div class="page-wrap support-page">
    <div class="page-heading">
      <h1>你的购物伙伴</h1>
      <p>从一件商品，到一笔订单。接着你的问题聊。</p>
    </div>
    <div v-if="!shop.user" class="support-login">
      <MessageCircle :size="40" />
      <h2>登录后，继续这段对话</h2>
      <p>客服会根据当前账号展示订单和会话，登录后即可保存咨询记录。</p>
      <RouterLink
        :to="{ path: '/login', query: { redirect: route.fullPath } }"
        class="button"
        >登录并咨询</RouterLink
      >
      <div class="guest-faq">
        <h3>常见问题</h3>
        <details
          v-for="f in shop.db.faqs.filter((f) => f.active).slice(0, 4)"
          :key="f.id"
        >
          <summary>{{ f.question }}</summary>
          <p>{{ f.answer }}</p>
        </details>
      </div>
    </div>
    <div v-else class="support-layout" data-ui>
      <aside class="conversation-list">
        <button class="button" :disabled="busy" @click="start()">
          <Plus :size="18" />新建咨询
        </button>
        <p class="secondary">我的会话</p>
        <button
          v-for="c in conversations"
          :key="c.id"
          :class="{ selected: activeId === c.id }"
          @click="select(c.id)"
        >
          <span>{{ c.title }}</span
          ><small>{{ statusLabels[c.status] }}</small>
        </button>
        <p v-if="!conversations.length" class="secondary">
          还没有会话，从一个问题开始。
        </p>
      </aside>
      <section
        class="chat-panel"
        :class="{ 'has-conversation': !!conversation }"
      >
        <header class="chat-header">
          <div>
            <h2>{{ conversation?.title ?? "今天想了解什么？" }}</h2>
            <span class="secondary">{{
              conversation
                ? statusLabels[conversation.status]
                : aiEnabled === true
                  ? "AI 客服 · 操作需确认"
                  : aiEnabled === false
                    ? "规则客服"
                    : "在线客服"
            }}</span>
          </div>
          <button
            v-if="conversation && conversation.status === 'bot'"
            :disabled="busy"
            @click="transfer()"
          >
            转人工
          </button>
        </header>
        <div v-if="product" class="chat-context">
          <img :src="product.images[0]" :alt="product.name" />
          <div>
            <span class="secondary">正在咨询的商品</span
            ><RouterLink :to="`/products/${product.id}`"
              >{{ product.name }} <ArrowUpRight :size="15"
            /></RouterLink>
          </div>
        </div>
        <RouterLink
          v-if="order"
          :to="`/orders/${order.id}`"
          class="chat-order-context"
          >订单 {{ order.id }} · {{ orderLabels[order.status] }} ·
          {{ money(order.total) }} <ArrowUpRight :size="17"
        /></RouterLink>
        <div ref="messagesEl" class="chat-messages" aria-live="polite">
          <template v-if="conversation?.messages.length"
            ><article
              v-for="m in conversation.messages"
              :key="m.id"
              class="chat-message"
              :class="`message-${m.role}`"
            >
              <div class="message-avatar">
                <UserRound v-if="m.role === 'user'" :size="18" /><MessageCircle
                  v-else
                  :size="18"
                />
              </div>
              <div class="message-content">
                <span class="message-author">{{
                  m.role === "user"
                    ? shop.user?.name
                    : m.role === "agent"
                      ? "人工客服"
                      : m.source === "ai"
                        ? "AI 客服"
                        : "规则客服"
                }}</span>
                <p>{{ m.text }}</p>
                <details v-if="m.citations?.length" class="support-citations">
                  <summary>查看 {{ m.citations.length }} 条知识来源</summary>
                  <blockquote
                    v-for="citation in m.citations"
                    :key="citation.id"
                  >
                    <strong>{{ citation.title }}</strong>
                    <span v-if="citation.page">
                      · 第 {{ citation.page }} 页</span
                    >
                    <span v-else-if="citation.paragraph">
                      · 第 {{ citation.paragraph }} 段</span
                    >
                    <p>{{ citation.text }}</p>
                  </blockquote>
                </details>
                <div v-if="m.productIds?.length" class="chat-recommendations">
                  <template v-for="id in m.productIds" :key="id"
                    ><ProductCard
                      v-if="products.find((p) => p.id === id)"
                      :product="products.find((p) => p.id === id)!"
                      compact
                  /></template>
                </div>
                <RouterLink
                  v-if="m.orderId && orders.some((o) => o.id === m.orderId)"
                  :to="`/orders/${m.orderId}`"
                  class="text-link"
                  >查看订单详情</RouterLink
                ><time>{{ dateTime(m.createdAt) }}</time>
              </div>
            </article></template
          >
          <div v-else class="chat-welcome">
            <h3>选购的困惑，收货的期待。</h3>
            <p>
              问问配送、售后政策，或者告诉我想找的商品。订单问题请从订单详情进入，方便带上上下文。
            </p>
            <div class="quick-questions">
              <button
                v-for="question in [
                  '推荐一些家居好物',
                  '配送需要多久？',
                  '如何申请退款？',
                ]"
                :key="question"
                :disabled="busy"
                @click="send(question)"
              >
                {{ question }}
              </button>
            </div>
          </div>
          <div
            v-if="generating && detail?.run"
            class="support-progress"
            role="status"
          >
            {{ supportPhase(detail.run) }}，请稍候。离开后可返回查看结果。
          </div>
          <div v-if="detail?.run?.degraded?.length" class="support-progress">
            {{ detail.run.degraded.map(supportDegradation).join("；") }}
          </div>
          <div
            v-if="detail?.run?.status === 'failed'"
            class="support-progress"
            role="alert"
          >
            {{ supportFailure(detail.run.error) }}
            <button :disabled="busy" @click="retry">重试本轮</button>
          </div>
          <div v-if="detail?.proposals.length" class="support-proposals">
            <article
              v-for="proposal in detail.proposals"
              :key="proposal.id"
              class="support-proposal"
            >
              <h3>
                {{
                  {
                    addCart: "加入购物车",
                    cancelOrder: "取消待付款订单",
                    requestAfterSale: "申请售后",
                  }[proposal.kind]
                }}
              </h3>
              <p>{{ proposal.summary }}</p>
              <p
                v-if="
                  proposal.kind === 'addCart' &&
                  typeof proposal.details.price === 'number'
                "
              >
                单价 {{ money(proposal.details.price) }} · 可售库存
                {{ proposal.details.stock }} · 加购数量
                {{ proposal.details.quantity }}
              </p>
              <p
                v-if="
                  proposal.details.orderId &&
                  orders.find((o) => o.id === proposal.details.orderId)
                "
              >
                订单金额
                {{
                  money(
                    orders.find((o) => o.id === proposal.details.orderId)!
                      .total,
                  )
                }}
                ·
                {{
                  orderLabels[
                    orders.find((o) => o.id === proposal.details.orderId)!
                      .status
                  ]
                }}
              </p>
              <template v-if="proposal.kind === 'requestAfterSale'">
                <p
                  v-for="line in proposalLines(proposal.details)"
                  :key="line.id"
                >
                  {{ line.title }} × {{ line.quantity }}
                </p>
                <p>
                  申请原因：{{ proposal.details.reason }}<br />问题说明：{{
                    proposal.details.description
                  }}
                </p>
                <p v-if="typeof proposal.details.refundAmount === 'number'">
                  申请金额 {{ money(proposal.details.refundAmount) }} ·
                  {{
                    proposal.details.requiresReturn
                      ? "须退回商品"
                      : "无需退回商品"
                  }}，以人工审核结果为准。
                </p>
              </template>
              <p class="secondary">
                {{
                  {
                    pending: "等待你的确认",
                    confirmed: "已执行",
                    cancelled: "已取消",
                    expired: "已失效，请重新咨询",
                  }[proposal.status]
                }}
                · 有效至 {{ dateTime(proposal.expiresAt) }}
              </p>
              <template
                v-if="
                  proposal.status === 'pending' &&
                  conversation?.status === 'bot'
                "
              >
                <p>确认后将执行以上操作，请先核对商品、数量及订单。</p>
                <button
                  class="button"
                  :disabled="busy || generating"
                  @click="proposalAction(proposal.id, true)"
                >
                  确认{{
                    {
                      addCart: "加购",
                      cancelOrder: "取消订单",
                      requestAfterSale: "申请售后",
                    }[proposal.kind]
                  }}
                </button>
                <button
                  :disabled="busy"
                  @click="proposalAction(proposal.id, false)"
                >
                  不执行
                </button>
              </template>
            </article>
          </div>
          <div v-if="detailError" class="support-progress" role="alert">
            {{ detailError }}
            <button @click="refreshDetail">重新读取会话</button>
          </div>
        </div>
        <ActionNotice :error="error" :notice="notice" />
        <form
          v-if="conversation?.status !== 'closed'"
          class="chat-composer"
          @submit.prevent="send()"
        >
          <label class="sr-only" for="chat-message">输入咨询内容</label
          ><textarea
            id="chat-message"
            v-model="text"
            rows="2"
            maxlength="1000"
            placeholder="说说你的问题…"
            @keydown.ctrl.enter.prevent="send()"
          ></textarea
          ><button
            class="button"
            :disabled="busy || generating || !text.trim()"
            aria-label="发送消息"
          >
            <Send :size="18" /><span>{{ pending ? "发送中" : "发送" }}</span>
          </button>
        </form>
        <div v-else class="chat-closed">
          <p>会话已结束，历史记录仍可查看。</p>
          <button class="button" @click="start()">开启新的咨询</button>
        </div>
        <p class="chat-disclaimer">
          {{
            aiEnabled
              ? "AI 回答可能存在偏差，请核对引用和业务卡片。加购、取消订单与申请售后须由你确认，不会自动付款或批准退款。"
              : "规则客服基于 FAQ 与商品数据回复，不会替你付款或批准退款。"
          }}
        </p>
      </section>
    </div>
    <CollectionPager />
  </div>
</template>

<style scoped>
.support-progress,
.support-proposals {
  padding: 12px 24px;
  border-top: 1px solid var(--line, #deded8);
}
.support-progress {
  color: var(--muted, #62645e);
  font-size: 13px;
}
.support-progress button,
.support-proposal > button {
  margin: 4px 12px 4px 0;
}
.support-proposal {
  padding: 14px 0;
}
.support-proposal + .support-proposal {
  border-top: 1px solid var(--line, #deded8);
}
.support-proposal h3 {
  font-size: 16px;
  margin: 0 0 8px;
}
.support-proposal p {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  margin: 8px 0;
}
.support-citations {
  margin: 12px 0;
  font-size: 13px;
}
.support-citations summary {
  cursor: pointer;
}
.support-citations blockquote {
  margin: 12px 0;
  padding-left: 12px;
  border-left: 2px solid #b7beb1;
}
.support-citations p {
  white-space: pre-wrap;
}
</style>
