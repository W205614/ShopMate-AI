import { computed, ref } from "vue";
import { useShop } from "../../stores/shop";
export function useAction() {
  const shop = useShop(),
    pending = ref(false);
  const busy = computed(
      () => pending.value || shop.syncStatus.phase !== "ready",
    ),
    error = ref(""),
    notice = ref("");
  async function run(action: () => Promise<unknown>, success = "") {
    if (busy.value) return false;
    pending.value = true;
    error.value = "";
    notice.value = "";
    try {
      await action();
      notice.value = success;
      return true;
    } catch (e) {
      error.value = e instanceof Error ? e.message : "操作失败，请重试";
      return false;
    } finally {
      pending.value = false;
    }
  }
  return { busy, pending, error, notice, run };
}
