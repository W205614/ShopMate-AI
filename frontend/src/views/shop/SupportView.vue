<script setup lang="ts">
import CollectionPager from "../../components/shop/CollectionPager.vue";
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  Send,
  Plus,
  ArrowUpRight,
  UserRound,
  MessageCircle,
} from "lucide-vue-next";
import { useShop } from "../../stores/shop";
import { api } from "../../services/api";
import { dateTime, orderLabels, money } from "../../domain/types";
import ProductCard from "../../components/shop/ProductCard.vue";
import ActionNotice from "../../components/shop/ActionNotice.vue";
import { useAction } from "../../components/shop/useAction";
const shop = useShop(),
  route = useRoute(),
  router = useRouter(),
  activeId = ref(""),
  text = ref(""),
  messagesEl = ref<HTMLElement>(),
  { busy, pending, error, notice, run } = useAction();
const conversations = computed(() =>
    shop.db.conversations
      .filter((c) => c.userId === shop.userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  ),
  conversation = computed(() =>
    conversations.value.find((c) => c.id === activeId.value),
  ),
  product = computed(() =>
    shop.db.products.find((p) => p.id === conversation.value?.productId),
  ),
  order = computed(() =>
    shop.myOrders.find((o) => o.id === conversation.value?.orderId),
  );
const statusLabels = {
  bot: "模拟客服",
  waiting: "等待人工接入",
  human: "人工服务中",
  closed: "会话已结束",
};
async function start(context?: { productId?: string; orderId?: string }) {
  if (!shop.user) {
    await router.push({ path: "/login", query: { redirect: route.fullPath } });
    return;
  }
  await run(async () => {
    activeId.value = await api.createConversation(context);
  });
}
function transfer() {
  return run(
    () => api.transferConversation(activeId.value),
    "已提交转人工，请在管理端客服工作台接入。",
  );
}
async function initialize() {
  const productId = String(route.query.productId ?? ""),
    orderId = String(route.query.orderId ?? "");
  if (productId || orderId) {
    const existing = conversations.value.find(
      (c) =>
        c.status !== "closed" &&
        c.productId === (productId || undefined) &&
        c.orderId === (orderId || undefined),
    );
    if (existing) activeId.value = existing.id;
    else
      await start({
        productId: productId || undefined,
        orderId: orderId || undefined,
      });
  } else if (!activeId.value) activeId.value = conversations.value[0]?.id ?? "";
}
onMounted(initialize);
watch(() => route.query, initialize);
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
  if (!content) return;
  if (!conversation.value) {
    if (!shop.user) {
      await router.push({ path: "/login", query: { redirect: "/support" } });
      return;
    }
    if (
      !(await run(async () => {
        activeId.value = await api.createConversation();
      }))
    )
      return;
  }
  if (await run(() => api.sendMessage(activeId.value, content)))
    text.value = "";
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
          @click="activeId = c.id"
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
                : "规则匹配演示 · 未连接大模型"
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
                      : "模拟客服"
                }}</span>
                <p>{{ m.text }}</p>
                <div v-if="m.productIds?.length" class="chat-recommendations">
                  <template v-for="id in m.productIds" :key="id"
                    ><ProductCard
                      v-if="shop.db.products.find((p) => p.id === id)"
                      :product="shop.db.products.find((p) => p.id === id)!"
                      compact
                  /></template>
                </div>
                <RouterLink
                  v-if="
                    m.orderId && shop.myOrders.some((o) => o.id === m.orderId)
                  "
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
            :disabled="busy"
            @keydown.ctrl.enter.prevent="send()"
          ></textarea
          ><button
            class="button"
            :disabled="busy || !text.trim()"
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
          模拟客服基于本地 FAQ 与商品数据回复，不会替你付款或批准退款。
        </p>
      </section>
    </div>
    <CollectionPager />
  </div>
</template>
