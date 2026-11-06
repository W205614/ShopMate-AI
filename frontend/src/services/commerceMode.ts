import { ref } from "vue";
import { productionApi } from "./production";
const production = ref(false),
  loaded = ref(false),
  error = ref("");
let loading: Promise<void> | undefined;
export function useCommerceMode() {
  loading ??= productionApi
    .capabilities()
    .then((value) => {
      production.value = value.mode === "production";
      loaded.value = true;
    })
    .catch((cause) => {
      error.value =
        cause instanceof Error ? cause.message : "无法读取商城运行模式";
    });
  return { production, loaded, error };
}
