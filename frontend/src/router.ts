import { createRouter, createWebHistory } from "vue-router";
import {
  getSession,
  refreshState,
  getSyncStatus,
  hasConfirmedLogout,
} from "./services/api";

const router = createRouter({
  history: createWebHistory(),
  scrollBehavior(to, from, saved) {
    return saved ?? (to.path === from.path ? undefined : { top: 0 });
  },
  routes: [
    {
      path: "/register",
      component: () => import("./views/LoginView.vue"),
      meta: { title: "注册账号", register: true },
    },
    {
      path: "/login",
      component: () => import("./views/LoginView.vue"),
      meta: { title: "用户登录" },
    },
    {
      path: "/admin/login",
      component: () => import("./views/LoginView.vue"),
      meta: { title: "管理登录", loginRole: "admin" },
    },
    {
      path: "/",
      component: () => import("./components/shop/ShopLayout.vue"),
      children: [
        {
          path: "",
          component: () => import("./views/shop/HomeView.vue"),
          meta: { title: "好物与答案，一起找到" },
        },
        {
          path: "categories",
          component: () => import("./views/shop/CategoriesView.vue"),
          meta: { title: "商品分类" },
        },
        {
          path: "products",
          component: () => import("./views/shop/ProductsView.vue"),
          meta: { title: "全部商品" },
        },
        {
          path: "products/:id",
          component: () => import("./views/shop/ProductView.vue"),
          meta: { title: "商品详情" },
        },
        {
          path: "cart",
          component: () => import("./views/shop/CartView.vue"),
          meta: { title: "购物车", auth: "user" },
        },
        {
          path: "checkout",
          component: () => import("./views/shop/CheckoutView.vue"),
          meta: { title: "确认订单", auth: "user" },
        },
        {
          path: "orders",
          component: () => import("./views/shop/OrdersView.vue"),
          meta: { title: "我的订单", auth: "user" },
        },
        {
          path: "orders/:id/pay",
          component: () => import("./views/shop/PaymentView.vue"),
          meta: { title: "模拟支付", auth: "user" },
        },
        {
          path: "orders/:id",
          component: () => import("./views/shop/OrderView.vue"),
          meta: { title: "订单详情", auth: "user" },
        },
        {
          path: "account",
          component: () => import("./views/shop/AccountView.vue"),
          meta: { title: "个人中心", auth: "user" },
        },
        {
          path: "coupons",
          component: () => import("./views/shop/CouponsView.vue"),
          meta: { title: "领券中心" },
        },
        {
          path: "after-sales",
          component: () => import("./views/shop/AfterSalesView.vue"),
          meta: { title: "售后进度", auth: "user" },
        },
        {
          path: "support",
          component: () => import("./views/shop/SupportView.vue"),
          meta: { title: "购物与服务咨询", auth: "user" },
        },
        {
          path: "credits",
          component: () => import("./views/CreditsView.vue"),
          meta: { title: "素材与演示说明" },
        },
      ],
    },
    {
      path: "/admin",
      component: () => import("./views/admin/AdminLayout.vue"),
      meta: { auth: "admin" },
      children: [
        {
          path: "",
          component: () => import("./views/admin/DashboardView.vue"),
          meta: { title: "经营概览" },
        },
        {
          path: "products",
          component: () => import("./views/admin/ProductsAdminView.vue"),
          meta: { title: "商品管理" },
        },
        {
          path: "categories",
          component: () => import("./views/admin/CategoriesAdminView.vue"),
          meta: { title: "分类管理" },
        },
        {
          path: "inventory",
          component: () => import("./views/admin/InventoryAdminView.vue"),
          meta: { title: "库存管理" },
        },
        {
          path: "orders",
          component: () => import("./views/admin/OrdersAdminView.vue"),
          meta: { title: "订单管理" },
        },
        {
          path: "after-sales",
          component: () => import("./views/admin/AfterSalesAdminView.vue"),
          meta: { title: "售后管理" },
        },
        {
          path: "finance",
          component: () => import("./views/admin/FinanceAdminView.vue"),
          meta: { title: "收支流水" },
        },
        {
          path: "coupons",
          component: () => import("./views/admin/CouponsAdminView.vue"),
          meta: { title: "优惠券管理" },
        },
        {
          path: "reviews",
          component: () => import("./views/admin/ReviewsAdminView.vue"),
          meta: { title: "评价管理" },
        },
        {
          path: "support",
          component: () => import("./views/admin/SupportAdminView.vue"),
          meta: { title: "客服工作台" },
        },
        {
          path: "knowledge",
          component: () => import("./views/admin/KnowledgeAdminView.vue"),
          meta: { title: "FAQ 管理" },
        },
        {
          path: "settings",
          component: () => import("./views/admin/SettingsAdminView.vue"),
          meta: { title: "演示设置" },
        },
      ],
    },
    {
      path: "/forbidden",
      component: () => import("./views/StatusView.vue"),
      meta: { title: "无权访问" },
    },
    {
      path: "/:pathMatch(.*)*",
      component: () => import("./views/StatusView.vue"),
      meta: { title: "页面不存在" },
    },
  ],
});
router.beforeEach(async (to) => {
  document.title = `${String(to.meta.title ?? "商城")} · ShopMate-AI`;
  const role = to.meta.auth;
  try {
    await refreshState(to.path.startsWith("/admin") ? "admin" : "user");
  } catch {
    /* Connection errors are shown by App; protected routes fail closed. */
  }
  if (
    (role === "user" || role === "admin") &&
    (getSyncStatus().phase === "ready" || hasConfirmedLogout(role)) &&
    !getSession(role)
  )
    return {
      path: role === "admin" ? "/admin/login" : "/login",
      query: { redirect: to.fullPath },
    };
});
export default router;
