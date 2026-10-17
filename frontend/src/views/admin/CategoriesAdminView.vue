<script setup lang="ts">
import { computed, reactive, ref, watch, nextTick } from "vue";
import { ElMessageBox, type TableInstance } from "element-plus";
import { useShop } from "../../stores/shop";
import { api } from "../../services/api";
import type { Category, CategoryInput } from "../../domain/types";
import { useAdminAction } from "./useAdmin";
import ImageEditor from "../../components/admin/ImageEditor.vue";
import { validateDecodedImages } from "../../services/images";
import { useAdminQuery, useAdminPagination } from "./useAdminList";
import { useAdminEditor } from "./useAdminEditor";
const shop = useShop(),
  { busy, pending, run } = useAdminAction(),
  filters = useAdminQuery(),
  query = filters.field("q", { replace: true }),
  direction = filters.field("sort", { values: ["asc", "desc"] }),
  imageBusy = ref(false);
const form = reactive<CategoryInput>({
  name: "",
  description: "",
  image: "",
  sort: 0,
});
const filtered = computed(() =>
  shop.db.categories
    .filter(
      (c) =>
        !query.value.trim() ||
        [c.name, c.description].some((value) =>
          value.toLowerCase().includes(query.value.trim().toLowerCase()),
        ),
    )
    .sort((a, b) => (a.sort - b.sort) * (direction.value === "desc" ? -1 : 1)),
);
const { page, rows } = useAdminPagination(filtered, filters);
const { dialog, detailId, missing, open, capture, finish, assertCurrent } =
  useAdminEditor(
    computed(() => shop.db.categories),
    filters,
    load,
    () => pending.value || imageBusy.value,
    () => shop.adminSession?.id,
  );
const table = ref<TableInstance>();
function sortChanged({ order }: { order: string | null }) {
  const next =
    order === "ascending" ? "asc" : order === "descending" ? "desc" : "";
  if (next !== direction.value) direction.value = next;
}
watch(direction, async () => {
  await nextTick();
  if (direction.value)
    table.value?.sort(
      "sort",
      direction.value === "asc" ? "ascending" : "descending",
    );
  else table.value?.clearSort();
});
const images = computed({
  get: () => (form.image ? [form.image] : []),
  set: (values: string[]) => {
    form.image = values[0] ?? "";
  },
});
function load(c?: Category) {
  Object.assign(
    form,
    c
      ? { ...c }
      : {
          id: undefined,
          name: "",
          description: "",
          image: "",
          sort: shop.db.categories.length + 1,
        },
  );
}
async function save() {
  if (imageBusy.value) return;
  const target = capture();
  if (!form.name.trim() || !form.description.trim() || !form.image.trim())
    return void run(async () => {
      throw Error("请填写分类名称、描述和图片地址");
    });
  if (
    await run(async () => {
      const input = { ...form };
      await validateDecodedImages([input.image], 1);
      assertCurrent(target);
      await api.saveCategory(input);
    }, "分类已保存")
  )
    finish(target);
}
async function remove(c: Category) {
  try {
    await ElMessageBox.confirm(
      `确认删除「${c.name}」？有商品引用的分类无法删除。`,
      "删除分类",
      { type: "warning" },
    );
    await run(() => api.deleteCategory(c.id), "分类已删除");
  } catch {
    /* dismissed */
  }
}
</script>
<template>
  <div class="admin-page-head">
    <div>
      <h1>分类管理</h1>
      <p>清晰的目录，让商品更容易被找到。</p>
    </div>
    <el-button type="primary" :disabled="pending || imageBusy" @click="open()"
      >新建分类</el-button
    >
  </div>
  <section class="admin-panel">
    <div class="admin-toolbar">
      <el-input
        v-model="query"
        placeholder="搜索分类名称或描述"
        clearable
      /><span class="admin-note">{{ filtered.length }} 个分类</span>
    </div>
    <el-table
      ref="table"
      :data="rows"
      @sort-change="sortChanged"
      :default-sort="{
        prop: 'sort',
        order:
          direction === 'asc'
            ? 'ascending'
            : direction === 'desc'
              ? 'descending'
              : undefined,
      }"
      empty-text="暂无符合条件的分类"
      ><el-table-column label="分类" min-width="210"
        ><template #default="{ row }"
          ><div class="admin-product-cell">
            <img :src="row.image" :alt="row.name" /><span>{{ row.name }}</span>
          </div></template
        ></el-table-column
      ><el-table-column
        prop="description"
        label="描述"
        required
        min-width="220"
      /><el-table-column
        prop="sort"
        label="排序"
        sortable="custom"
        width="100"
      /><el-table-column label="商品数" width="110"
        ><template #default="{ row }">{{
          shop.db.products.filter((p) => p.categoryId === row.id).length
        }}</template></el-table-column
      ><el-table-column label="操作" width="140"
        ><template #default="{ row }"
          ><el-button
            link
            type="primary"
            :disabled="pending || imageBusy"
            @click="open(row)"
            >编辑</el-button
          ><el-button link type="danger" @click="remove(row)"
            >删除</el-button
          ></template
        ></el-table-column
      ></el-table
    >
    <div class="admin-pagination">
      <el-pagination
        v-model:current-page="page"
        :page-size="10"
        :total="filtered.length"
        layout="prev,pager,next,total"
      />
    </div>
  </section>
  <el-dialog
    v-model="dialog"
    :title="detailId ? '编辑分类' : '新建分类'"
    width="500px"
    :close-on-click-modal="!pending && !imageBusy"
    :close-on-press-escape="!pending && !imageBusy"
    :show-close="!pending && !imageBusy"
    ><el-alert
      v-if="missing"
      title="没有找到该分类"
      type="warning"
      :closable="false"
    /><el-form
      v-else
      label-position="top"
      :disabled="busy || imageBusy"
      @submit.prevent="save"
      ><el-form-item label="分类名称" required
        ><el-input v-model="form.name" maxlength="30" /></el-form-item
      ><el-form-item label="描述" required
        ><el-input v-model="form.description" type="textarea" /></el-form-item
      ><el-form-item label="分类图片" required
        ><ImageEditor
          v-model="images"
          label="分类图片"
          :maximum="1"
          :disabled="busy"
          @busy="imageBusy = $event" /></el-form-item
      ><el-form-item label="排序（越小越靠前）"
        ><el-input-number
          v-model="form.sort"
          :precision="0"
          :min="0" /></el-form-item></el-form
    ><template #footer
      ><el-button :disabled="pending || imageBusy" @click="dialog = false"
        >取消</el-button
      ><el-button
        v-if="!missing"
        type="primary"
        :loading="pending"
        :disabled="busy || imageBusy"
        @click="save"
        >保存</el-button
      ></template
    ></el-dialog
  >
</template>
