import { computed, ref, watch, type Ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { getCollectionPage, routeCollection } from "../../services/api";
export function useAdminQuery() {
  const route = useRoute(),
    router = useRouter();
  // Inputs must update synchronously while guards await HTTP. All fields and
  // pagination share this draft, so a second edit cannot discard the first.
  const query = ref({ ...route.query });
  const navigating = ref(false);
  let navigation = 0;
  watch(
    () => route.fullPath,
    () => {
      query.value = { ...route.query };
    },
  );
  async function update(
    patch: Record<string, string | undefined>,
    options: { resetPage?: boolean; replace?: boolean } = {},
  ) {
    const next = { ...query.value };
    for (const [key, value] of Object.entries(patch)) {
      if (!value) delete next[key];
      else next[key] = value;
    }
    if (options.resetPage) delete next.page;
    const current = ++navigation;
    navigating.value = true;
    query.value = next;
    try {
      const failure = await router[options.replace ? "replace" : "push"]({
        query: next,
      });
      if (failure && current === navigation) query.value = { ...route.query };
      return failure;
    } catch (error) {
      if (current === navigation) query.value = { ...route.query };
      throw error;
    } finally {
      if (current === navigation) navigating.value = false;
    }
  }
  function field(
    key: string,
    options: { values?: string[]; resetPage?: boolean; replace?: boolean } = {},
  ) {
    return computed({
      get: () => {
        const value = query.value[key];
        return typeof value === "string" &&
          (!options.values || options.values.includes(value))
          ? value
          : "";
      },
      set: (value) => {
        void update(
          { [key]: value },
          { resetPage: options.resetPage !== false, replace: options.replace },
        ).catch(() => undefined);
      },
    });
  }
  return { field, update, query, navigating };
}
export function useAdminPagination<T>(
  items: Readonly<Ref<T[]>>,
  state: ReturnType<typeof useAdminQuery>,
) {
  const { update, query } = state;
  const metadata = computed(() => {
    void items.value;
    return getCollectionPage(routeCollection() ?? "");
  });
  const total = computed(() => metadata.value?.total ?? items.value.length);
  const pages = computed(
    () =>
      metadata.value?.pages ?? Math.max(1, Math.ceil(items.value.length / 10)),
  );
  const page = computed({
    get: () => {
      const raw =
        typeof query.value.page === "string" ? Number(query.value.page) : 1;
      return Math.min(
        Number.isSafeInteger(raw) && raw > 0 ? raw : 1,
        pages.value,
      );
    },
    set: (value) => {
      void update({ page: value > 1 ? String(value) : undefined }).catch(
        () => undefined,
      );
    },
  });
  watch(
    [() => query.value.page, pages, state.navigating],
    () => {
      if (state.navigating.value) return;
      const expected = page.value > 1 ? String(page.value) : undefined;
      if (query.value.page !== expected)
        void update({ page: expected }, { replace: true }).catch(
          () => undefined,
        );
    },
    { immediate: true },
  );
  const rows = computed(() =>
    metadata.value
      ? items.value.filter(
          (item) =>
            metadata.value?.ids?.includes((item as { id: string }).id) ?? true,
        )
      : items.value.slice((page.value - 1) * 10, page.value * 10),
  );
  return { page, rows, pages, total };
}
