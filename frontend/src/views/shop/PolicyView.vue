<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { productionApi, type Merchant } from "../../services/production";
const route = useRoute(),
  merchant = ref<Merchant | null>(null),
  error = ref("");
const policy = computed(() =>
  route.params.kind === "privacy"
    ? merchant.value?.privacy
    : merchant.value?.terms,
);
watch(
  () => route.params.kind,
  async () => {
    merchant.value = null;
    error.value = "";
    if (!["privacy", "terms"].includes(String(route.params.kind))) {
      error.value = "未找到该协议";
      return;
    }
    try {
      merchant.value = await productionApi.merchant();
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : "协议暂时无法读取";
    }
  },
  { immediate: true },
);
</script>
<template>
  <article class="page-wrap policy-page">
    <p v-if="error" role="alert">{{ error }}</p>
    <template v-else-if="policy && merchant">
      <h1>
        {{
          policy.title ||
          (route.params.kind === "privacy" ? "隐私政策" : "服务协议")
        }}
      </h1>
      <p class="secondary">
        {{ merchant.legalName }} · 版本 {{ policy.version || "未发布" }}
      </p>
      <p v-if="!policy.text">商家尚未发布本协议。</p>
      <div class="policy-content">{{ policy.text }}</div>
      <p
        v-if="merchant.serviceEmail || merchant.servicePhone"
        class="secondary"
      >
        联系方式：{{ merchant.serviceEmail }} {{ merchant.servicePhone }}
      </p>
    </template>
    <p v-else role="status">正在读取协议…</p>
  </article>
</template>
<style scoped>
.policy-page {
  max-width: 880px;
  padding-block: 48px;
}
.policy-content {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.9;
  margin-block: 28px;
}
</style>
