<script setup lang="ts">
import { computed, ref, getCurrentInstance } from "vue";
import ElementPlus from "element-plus";
import zhCn from "element-plus/es/locale/lang/zh-cn";
import {
  LayoutDashboard,
  Package,
  Shapes,
  Boxes,
  ShoppingBag,
  RotateCcw,
  Receipt,
  Ticket,
  Star,
  MessagesSquare,
  BookOpen,
  Settings2,
  Menu,
} from "lucide-vue-next";
import { RouterLink, RouterView, useRoute, useRouter } from "vue-router";
import "element-plus/dist/index.css";
import "../../styles/admin.css";
import { useShop } from "../../stores/shop";
import { canOpenAdminPath } from "../../router";
const shop = useShop(),
  route = useRoute(),
  router = useRouter();
getCurrentInstance()!.appContext.app.use(ElementPlus, { locale: zhCn });
const icons = [
  LayoutDashboard,
  Package,
  Shapes,
  Boxes,
  ShoppingBag,
  RotateCcw,
  Receipt,
  Ticket,
  Star,
  MessagesSquare,
  BookOpen,
  Settings2,
];
const expanded = ref(false);
const allLinks = [
  ["/admin", "经营概览", "Overview"],
  ["/admin/products", "商品管理", "Products"],
  ["/admin/categories", "分类管理", "Categories"],
  ["/admin/inventory", "库存管理", "Inventory"],
  ["/admin/orders", "订单管理", "Orders"],
  ["/admin/after-sales", "售后管理", "After sales"],
  ["/admin/finance", "收支流水", "Finance"],
  ["/admin/coupons", "优惠券管理", "Coupons"],
  ["/admin/reviews", "评价管理", "Reviews"],
  ["/admin/support", "客服工作台", "Support"],
  ["/admin/knowledge", "FAQ 管理", "Knowledge"],
  ["/admin/settings", "演示设置", "Settings"],
  ["/admin/operations", "经营工作台", "Operations"],
];
const links = computed(() =>
  allLinks.filter((link) =>
    canOpenAdminPath(link[0]!, shop.adminSession?.permissions ?? []),
  ),
);
const title = computed(
  () => links.value.find((l) => l[0] === route.path)?.[1] || "管理中心",
);
async function logout() {
  await shop.logout("admin");
  await router.push("/admin/login");
}
</script>
<template>
  <div class="admin-app" data-ui>
    <button
      v-if="expanded"
      class="admin-nav-scrim"
      aria-label="关闭导航"
      @click="expanded = false"
    />
    <aside class="admin-sidebar" :class="{ expanded }">
      <RouterLink class="admin-brand" to="/admin"
        >ShopMate<span>运营管理台</span></RouterLink
      >
      <nav aria-label="管理导航">
        <RouterLink
          v-for="(link, i) in links"
          :key="link[0]"
          :to="link[0]!"
          :class="{ selected: route.path === link[0] }"
          @click="expanded = false"
          ><component
            :is="icons[i] ?? Boxes"
            :size="17"
            aria-hidden="true"
          /><span
            >{{ link[1] }}<small>{{ link[2] }}</small></span
          ></RouterLink
        >
      </nav>
      <div class="admin-sidebar-bottom">
        <RouterLink to="/">前往商城 ↗</RouterLink>
        <p>业务体验版 · 数据由服务端保存</p>
      </div>
    </aside>
    <div class="admin-workspace">
      <header class="admin-topbar">
        <div>
          <button
            class="admin-mobile-toggle"
            aria-label="切换导航"
            :aria-expanded="expanded"
            @click="expanded = !expanded"
          >
            <Menu :size="20" /></button
          ><span>工作空间</span><b>/ {{ title }}</b>
        </div>
        <div>
          <span class="admin-demo-dot">演示环境</span
          ><span>{{ shop.adminSession?.name }}</span
          ><button class="admin-text-button" @click="logout">退出</button>
        </div>
      </header>
      <main class="admin-main"><RouterView /></main>
      <footer class="admin-foot">
        ShopMate-AI · 单店自营演示 <span>所有交易、物流和客服均为模拟</span>
      </footer>
    </div>
  </div>
</template>
<style scoped>
.admin-sidebar nav {
  overflow-y: auto;
  min-height: 0;
}
</style>
