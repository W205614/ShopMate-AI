<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  Search,
  ShoppingBag,
  UserRound,
  ArrowUpRight,
  MessageCircle,
  Menu,
  Bell,
  X,
} from "lucide-vue-next";
import { queryText } from "../../domain/catalogue";
import { useShop } from "../../stores/shop";
import { productionApi } from "../../services/production";
import { request } from "../../services/repository";
import "../../styles/shop.css";
const shop = useShop(),
  route = useRoute(),
  router = useRouter(),
  search = ref(queryText(route.query.q)),
  menu = ref(false);
const mode = ref<"demo" | "production" | null>(null);
const unread = ref<number | null>(null);
let unreadRequest = 0;
let unreadTimer: number | undefined;
async function loadUnread() {
  const current = ++unreadRequest;
  if (!shop.userId) {
    unread.value = null;
    return;
  }
  if (document.hidden) return;
  try {
    const result = await request<{ unread: number }>(
      "/api/member/notifications/unread",
    );
    if (current === unreadRequest) unread.value = result.unread;
  } catch {
    if (current === unreadRequest) unread.value = null;
  }
}
watch(
  () => shop.userId,
  () => {
    unread.value = null;
    void loadUnread();
  },
  { immediate: true },
);
watch([() => route.fullPath, () => shop.db.revision], () => void loadUnread());
onMounted(async () => {
  unreadTimer = window.setInterval(loadUnread, 15000);
  document.addEventListener("visibilitychange", loadUnread);
  try {
    mode.value = (await productionApi.capabilities()).mode;
  } catch {
    mode.value = null;
  }
});
onUnmounted(() => {
  unreadRequest++;
  window.clearInterval(unreadTimer);
  document.removeEventListener("visibilitychange", loadUnread);
});
watch(
  () => route.fullPath,
  () => {
    menu.value = false;
    search.value = queryText(route.query.q);
  },
);
function submit() {
  router.push({
    path: "/products",
    query: search.value.trim() ? { q: search.value.trim() } : {},
  });
}
</script>
<template>
  <div class="shop-site">
    <a href="#main" class="skip-link">跳到主要内容</a>
    <header class="shop-header">
      <RouterLink to="/" class="wordmark" aria-label="ShopMate 首页"
        >{{ shop.db.settings.name }}<span>好物商店</span></RouterLink
      >
      <nav class="desktop-nav" aria-label="主导航">
        <RouterLink to="/products">全部商品</RouterLink
        ><RouterLink to="/categories">按类挑选</RouterLink
        ><RouterLink to="/support">购物伙伴</RouterLink>
      </nav>
      <form class="header-search" @submit.prevent="submit">
        <Search :size="18" /><input
          v-model="search"
          aria-label="搜索商品"
          maxlength="100"
          placeholder="想找点什么？"
        /><button type="submit" aria-label="提交搜索">
          <ArrowUpRight :size="19" />
        </button>
      </form>
      <div class="header-actions">
        <RouterLink to="/account" aria-label="个人中心"
          ><UserRound :size="21" /><span>{{
            shop.user?.name ?? "登录"
          }}</span></RouterLink
        ><RouterLink to="/cart" aria-label="购物车"
          ><ShoppingBag :size="21" /><span>{{
            shop.summary.cartQuantity
          }}</span></RouterLink
        ><RouterLink
          v-if="shop.userId"
          to="/notifications"
          :aria-label="unread ? `站内通知，${unread} 条未读` : '站内通知'"
        >
          <Bell :size="21" />
          <span v-if="unread">{{ unread }}</span> </RouterLink
        ><button
          class="mobile-menu"
          aria-label="切换导航菜单"
          :aria-expanded="menu"
          @click="menu = !menu"
        >
          <X v-if="menu" /><Menu v-else />
        </button>
      </div>
    </header>
    <nav v-if="menu" class="mobile-nav" aria-label="移动导航">
      <RouterLink to="/products">全部商品</RouterLink
      ><RouterLink to="/categories">按类挑选</RouterLink
      ><RouterLink to="/orders">我的订单</RouterLink
      ><RouterLink to="/support">购物伙伴</RouterLink>
    </nav>
    <main id="main"><RouterView /></main>
    <footer class="shop-footer">
      <div class="footer-top">
        <p>从选购到收货，<br />有问题，随时问。</p>
        <RouterLink to="/support" class="footer-contact"
          >找购物伙伴 <ArrowUpRight :size="30"
        /></RouterLink>
      </div>
      <div class="footer-links">
        <span
          >中文综合百货 ·
          {{
            mode === "production"
              ? "单店自营"
              : mode === "demo"
                ? "单店自营演示"
                : "商城"
          }}</span
        ><RouterLink to="/orders">我的订单</RouterLink
        ><RouterLink to="/after-sales">售后服务</RouterLink
        ><RouterLink to="/credits">图片来源与许可</RouterLink
        ><RouterLink to="/policies/privacy">隐私政策</RouterLink
        ><RouterLink to="/policies/terms">服务协议</RouterLink
        ><RouterLink to="/admin/login">管理入口</RouterLink>
      </div>
      <div class="footer-brand">SHOPMATE</div>
      <p class="footer-note">
        {{
          mode === "production"
            ? "商品、价格、库存与订单状态以服务端当前记录为准。"
            : mode === "demo"
              ? "所有价格、库存与业务记录仅供功能演示。不产生真实交易。"
              : "请在订单页核对交易状态，或联系客服。"
        }}
      </p>
    </footer>
    <RouterLink
      v-if="
        !['/', '/support', '/cart', '/checkout'].includes(route.path) &&
        !route.path.endsWith('/pay')
      "
      to="/support"
      class="support-float"
      aria-label="问问客服"
      ><MessageCircle :size="21" /><span>问问客服</span></RouterLink
    >
  </div>
</template>
