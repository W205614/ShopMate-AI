<script setup lang="ts">
import { ref, watch, onErrorCaptured } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useShop } from "./stores/shop";
import { hasPasswordChangeNotice } from "./services/api";
const shop = useShop();
const route = useRoute(),
  router = useRouter();
watch(
  () => [shop.userSession, shop.adminSession],
  () => {
    const role = route.meta.auth;
    if (shop.storageIssue) return;
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
onErrorCaptured((cause) => {
  error.value = cause instanceof Error ? cause.message : "页面加载失败";
  return false;
});
</script>
<template>
  <aside v-if="shop.storageIssue" class="storage-warning" role="alert">
    {{ shop.storageIssue }}。请检查服务连接后刷新页面。
  </aside>
  <div v-if="error" class="app-failure" role="alert">
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
