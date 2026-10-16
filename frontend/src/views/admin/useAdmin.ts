import { ref } from "vue";
import { ElMessage } from "element-plus";

export function useAdminAction() {
  const busy = ref(false);
  async function run(action: () => Promise<unknown>, success = "操作已完成") {
    if (busy.value) return false;
    busy.value = true;
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
      busy.value = false;
    }
  }
  return { busy, run };
}
// Match dateTime() and date-picker inputs, both of which use browser local time.
export const localDate = (value: string | Date) => {
  const date = typeof value === 'string' ? new Date(value) : value;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
