<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useShop } from "../../stores/shop";
import { getCollectionPage, routeCollection } from "../../services/api";
const props = defineProps<{ collection?: string }>();
const shop = useShop(),
  route = useRoute(),
  router = useRouter();
const metadata = computed(() => {
  void shop.db.revision;
  return getCollectionPage(props.collection ?? routeCollection() ?? "");
});
function navigate(page: number) {
  void router.push({
    query: { ...route.query, page: page > 1 ? String(page) : undefined },
  });
}
</script>
<template>
  <nav
    v-if="metadata && metadata.pages > 1"
    class="button-row"
    aria-label="列表分页"
  >
    <button :disabled="metadata.page <= 1" @click="navigate(metadata.page - 1)">
      上一页</button
    ><span
      >{{ metadata.page }} / {{ metadata.pages }} · 共
      {{ metadata.total }} 条</span
    ><button
      :disabled="metadata.page >= metadata.pages"
      @click="navigate(metadata.page + 1)"
    >
      下一页
    </button>
  </nav>
</template>
