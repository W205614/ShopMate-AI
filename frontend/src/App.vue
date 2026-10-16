<script setup lang="ts">
import { ref, onErrorCaptured } from "vue";
import { useShop } from "./stores/shop";
const shop = useShop();
const error = ref("");
onErrorCaptured((cause) => {
  error.value = cause instanceof Error ? cause.message : "页面加载失败";
  return false;
});
</script>
<template>
  <aside v-if="shop.storageIssue" class="storage-warning" role="alert">
    {{ shop.storageIssue }}。原始数据未覆盖，当前仅显示初始预览。<RouterLink
      to="/admin/settings"
      >登录管理端后恢复</RouterLink
    >
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
