import { computed, onUnmounted, ref, watch, type Ref } from "vue";
import type { useAdminQuery } from "./useAdminList";

// Loading is tied to an explicit URL target, never to polling updates. If a
// target changes during a save/image read, finish the old work before loading it.
export function useAdminEditor<T extends { id: string }>(
  records: Readonly<Ref<T[]>>,
  query: ReturnType<typeof useAdminQuery>,
  load: (record?: T) => void,
  locked: () => boolean,
  owner: () => string | undefined,
) {
  const detailId = query.field("detail", { resetPage: false }),
    creating = ref(false),
    active = ref(false);
  const selected = computed(() =>
    records.value.find((r) => r.id === detailId.value),
  );
  let loadedId = "",
    alive = true,
    epoch = 0;
  watch(
    owner,
    () => {
      epoch++;
      loadedId = "";
      creating.value = false;
      active.value = false;
      detailId.value = "";
      load();
    },
    { flush: "sync" },
  );
  onUnmounted(() => {
    alive = false;
  });
  const dialog = computed({
    get: () => creating.value || !!detailId.value || (active.value && locked()),
    set: (open) => {
      if (open || locked()) return;
      creating.value = false;
      active.value = false;
      detailId.value = "";
    },
  });
  const missing = computed(
    () => !!detailId.value && !selected.value && !locked(),
  );
  watch(
    [detailId, locked, () => !!selected.value],
    () => {
      if (locked()) return;
      const id = detailId.value;
      if (!id) {
        loadedId = "";
        if (!creating.value) active.value = false;
        return;
      }
      creating.value = false;
      active.value = true;
      if (selected.value && loadedId !== id) {
        load(JSON.parse(JSON.stringify(selected.value)) as T);
        loadedId = id;
      }
    },
    { immediate: true },
  );
  function open(record?: T) {
    if (locked()) return;
    creating.value = !record;
    active.value = true;
    detailId.value = record?.id ?? "";
    load(record ? (JSON.parse(JSON.stringify(record)) as T) : undefined);
    loadedId = record?.id ?? "";
  }
  const capture = () => ({
    id: detailId.value,
    creating: creating.value,
    owner: owner(),
    epoch,
  });
  function finish(token: ReturnType<typeof capture>) {
    if (
      alive &&
      token.epoch === epoch &&
      token.owner === owner() &&
      token.id === detailId.value &&
      token.creating === creating.value
    )
      dialog.value = false;
  }
  function assertCurrent(token: ReturnType<typeof capture>) {
    if (
      !alive ||
      token.epoch !== epoch ||
      token.owner !== owner() ||
      token.id !== detailId.value ||
      token.creating !== creating.value
    )
      throw new Error("编辑目标或登录身份已变化，请重新核对后提交");
  }
  return { dialog, detailId, missing, open, capture, finish, assertCurrent };
}
