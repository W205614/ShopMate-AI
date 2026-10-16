import { ref } from 'vue'
export function useAction() {
  const busy = ref(false),
    error = ref(''),
    notice = ref('')
  async function run(action: () => Promise<unknown>, success = '') {
    if (busy.value) return false
    busy.value = true
    error.value = ''
    notice.value = ''
    try {
      await action()
      notice.value = success
      return true
    } catch (e) {
      error.value = e instanceof Error ? e.message : '操作失败，请重试'
      return false
    } finally {
      busy.value = false
    }
  }
  return { busy, error, notice, run }
}
