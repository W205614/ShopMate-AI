<script setup lang="ts">
import { ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  Search,
  ShoppingBag,
  UserRound,
  ArrowUpRight,
  MessageCircle,
  Menu,
  X,
} from "lucide-vue-next";
import { queryText } from "../../domain/catalogue";
import { useShop } from "../../stores/shop";
import "../../styles/shop.css";
const shop = useShop(),
  route = useRoute(),
  router = useRouter(),
  search = ref(queryText(route.query.q)),
  menu = ref(false);
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
        <span>中文综合百货 · 单店自营演示</span
        ><RouterLink to="/orders">我的订单</RouterLink
        ><RouterLink to="/after-sales">售后服务</RouterLink
        ><RouterLink to="/credits">图片来源与许可</RouterLink
        ><RouterLink to="/admin/login">管理入口</RouterLink>
      </div>
      <div class="footer-brand">SHOPMATE</div>
      <p class="footer-note">
        所有价格、库存与业务记录仅供功能演示。不产生真实交易。
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
