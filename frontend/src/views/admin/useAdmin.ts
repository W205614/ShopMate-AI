import { computed, ref } from "vue";
import { ElMessage } from "element-plus";
import { useShop } from "../../stores/shop";

export function useAdminAction() {
  const shop = useShop(),
    pending = ref(false);
  const busy = computed(
    () => pending.value || shop.syncStatus.phase !== "ready",
  );
  async function run(action: () => Promise<unknown>, success = "操作已完成") {
    if (busy.value) return false;
    pending.value = true;
    try {
      await action();
      ElMessage.success(success);
      return true;
    } catch (error) {
      ElMessage.error(
        error instanceof Error ? error.message : "操作失败，请重试",
      );
      return false;
    } finally {
      pending.value = false;
    }
  }
  return { busy, pending, run };
}
// Match dateTime() and date-picker inputs, both of which use browser local time.
export const localDate = (value: string | Date) => {
  const date = typeof value === "string" ? new Date(value) : value;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};
