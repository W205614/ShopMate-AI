<script setup lang="ts">
import { onMounted, ref } from "vue";
import { request } from "../../services/repository";
const props = defineProps<{ orderId: string }>();
type Shipment = {
  id: string;
  kind: string;
  carrier: string;
  tracking: string;
  status: string;
  lastError?: string;
  trace: { data?: { time: string; context: string }[] };
};
const items = ref<Shipment[]>([]),
  enabled = ref(false),
  busy = ref(false),
  error = ref("");
async function load() {
  const result = await request<{ enabled: boolean; items: Shipment[] }>(
    `/api/orders/${encodeURIComponent(props.orderId)}/shipment`,
  );
  enabled.value = result.enabled;
  items.value = result.items;
}
async function refresh(id: string) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await request(
      `/api/orders/${encodeURIComponent(props.orderId)}/shipment/${id}/refresh`,
      { requestId: crypto.randomUUID() },
    );
    await load();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "物流查询失败";
  } finally {
    busy.value = false;
  }
}
onMounted(() => {
  void load().catch((cause) => {
    error.value = cause instanceof Error ? cause.message : "无法读取物流";
  });
});
</script>
<template>
  <section aria-label="物流轨迹">
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="!enabled" class="secondary">
      商家尚未启用在线轨迹查询，请按运单信息联系承运商。
    </p>
    <article v-for="item in items" :key="item.id">
      <p>
        {{ item.kind === "return" ? "退货运单" : "发货运单" }}：{{
          item.carrier
        }}
        · {{ item.tracking }}
      </p>
      <p v-if="item.lastError" class="secondary">
        轨迹更新遇到问题：{{ item.lastError }}，已显示的轨迹保留。
      </p>
      <ol v-if="item.trace.data?.length">
        <li v-for="(entry, index) in item.trace.data" :key="index">
          {{ entry.time }} · {{ entry.context }}
        </li>
      </ol>
      <p v-else class="secondary">暂未收到物流轨迹。</p>
      <button
        v-if="enabled"
        type="button"
        class="text-link"
        :disabled="busy"
        @click="refresh(item.id)"
      >
        刷新物流轨迹
      </button>
    </article>
  </section>
</template>
