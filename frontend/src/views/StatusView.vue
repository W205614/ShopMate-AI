<script setup lang="ts">
import { useRoute } from "vue-router";
const route = useRoute();
</script>
<template>
  <main class="status-page">
    <h1>
      {{ route.path === "/forbidden" ? "无权访问此页面" : "这里还没有商品" }}
    </h1>
    <p>
      {{
        route.path === "/forbidden"
          ? "请使用对应角色的演示账号。"
          : "页面不存在，可能是地址有误。"
      }}
    </p>
    <RouterLink to="/">返回商城首页</RouterLink>
  </main>
</template>
