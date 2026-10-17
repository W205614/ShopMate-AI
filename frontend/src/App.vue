<script setup lang="ts">
import { computed, ref, watch, onErrorCaptured } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useShop } from "./stores/shop";
import {
  hasPasswordChangeNotice,
  refreshState,
  hasConfirmedLogout,
} from "./services/api";
const shop = useShop();
const route = useRoute(),
  router = useRouter();
const expectedRole = computed(() =>
  route.path.startsWith("/admin") ? "admin" : "user",
);
watch(
  () => [
    shop.userSession,
    shop.adminSession,
    shop.syncStatus.phase,
    route.fullPath,
  ],
  () => {
    const role = route.meta.auth;
    if (shop.syncStatus.role !== expectedRole.value) return;
    if (
      shop.syncStatus.phase !== "ready" &&
      !((role === "user" || role === "admin") && hasConfirmedLogout(role))
    )
      return;
    if (
      (role === "user" && !shop.userSession) ||
      (role === "admin" && !shop.adminSession)
    ) {
      const changed = role === "user" && hasPasswordChangeNotice();
      void router.replace({
        path: role === "admin" ? "/admin/login" : "/login",
        query: {
          redirect: route.fullPath,
          ...(changed ? { changed: "1" } : {}),
        },
      });
    }
  },
);
const error = ref("");
const reconnecting = ref(false);
const authPage = computed(
  () =>
    route.path === "/login" ||
    route.path === "/register" ||
    route.path === "/admin/login",
);
const unavailable = computed(
  () =>
    !authPage.value &&
    (shop.syncStatus.phase === "unavailable" ||
      shop.syncStatus.role !== expectedRole.value ||
      (shop.syncStatus.phase !== "ready" &&
        ((route.meta.auth === "user" && !shop.userSession) ||
          (route.meta.auth === "admin" && !shop.adminSession)))),
);
const unauthorized = computed(() => {
  const role = route.meta.auth;
  return (
    shop.syncStatus.phase === "ready" &&
    ((role === "user" && !shop.userSession) ||
      (role === "admin" && !shop.adminSession))
  );
});
async function reconnect() {
  if (reconnecting.value) return;
  reconnecting.value = true;
  try {
    await refreshState(shop.syncStatus.role);
  } catch {
    /* The repository keeps the visible connection error. */
  } finally {
    reconnecting.value = false;
  }
}
onErrorCaptured((cause) => {
  error.value = cause instanceof Error ? cause.message : "页面加载失败";
  return false;
});
</script>
<template>
  <aside
    v-if="shop.storageIssue && !unavailable"
    class="storage-warning"
    role="alert"
  >
    {{ shop.storageIssue }}
    <button :disabled="reconnecting" @click="reconnect">
      {{ reconnecting ? "正在连接…" : "重新连接" }}
    </button>
  </aside>
  <div v-if="unavailable" class="app-failure" role="alert">
    <h1>{{ shop.storageIssue ? "暂时无法连接服务" : "正在连接服务" }}</h1>
    <p>{{ shop.storageIssue || "正在确认服务端数据，请稍候。" }}</p>
    <button
      v-if="shop.storageIssue"
      :disabled="reconnecting"
      @click="reconnect"
    >
      {{ reconnecting ? "正在连接…" : "重新连接" }}
    </button>
  </div>
  <p v-else-if="unauthorized" class="page-loading" role="status">
    正在确认登录状态…
  </p>
  <div v-else-if="error" class="app-failure" role="alert">
    <h1>暂时无法打开页面</h1>
    <p>{{ error }}</p>
    <button @click="error = ''">重试</button
    ><a href="/admin/settings">前往演示设置</a>
  </div>
  <RouterView v-else v-slot="{ Component }">
    <component :is="Component" v-if="Component" />
    <p v-else class="page-loading" role="status">正在准备页面…</p>
  </RouterView>
</template>
