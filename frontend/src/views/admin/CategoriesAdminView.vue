<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { ElMessageBox } from "element-plus";
import { useShop } from "../../stores/shop";
import { api } from "../../services/api";
import type { Category, CategoryInput } from "../../domain/types";
import { useAdminAction } from "./useAdmin";
const shop = useShop(),
  { busy, pending, run } = useAdminAction(),
  dialog = ref(false);
const form = reactive<CategoryInput>({
  name: "",
  description: "",
  image: "",
  sort: 0,
});
const rows = computed(() =>
  [...shop.db.categories].sort((a, b) => a.sort - b.sort),
);
function open(c?: Category) {
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
  dialog.value = true;
}
async function save() {
  if (!form.name.trim() || !form.description.trim() || !form.image.trim())
    return void run(async () => {
      throw Error("请填写分类名称、描述和图片地址");
    });
  if (await run(() => api.saveCategory({ ...form }), "分类已保存"))
    dialog.value = false;
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
    <el-button type="primary" @click="open()">新建分类</el-button>
  </div>
  <section class="admin-panel">
    <el-table :data="rows" empty-text="暂无分类"
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
        sortable
        width="100"
      /><el-table-column label="商品数" width="110"
        ><template #default="{ row }">{{
          shop.db.products.filter((p) => p.categoryId === row.id).length
        }}</template></el-table-column
      ><el-table-column label="操作" width="140"
        ><template #default="{ row }"
          ><el-button link type="primary" @click="open(row)">编辑</el-button
          ><el-button link type="danger" @click="remove(row)"
            >删除</el-button
          ></template
        ></el-table-column
      ></el-table
    >
  </section>
  <el-dialog
    v-model="dialog"
    :title="form.id ? '编辑分类' : '新建分类'"
    width="500px"
    ><el-form label-position="top" @submit.prevent="save"
      ><el-form-item label="分类名称" required
        ><el-input v-model="form.name" maxlength="30" /></el-form-item
      ><el-form-item label="描述" required
        ><el-input v-model="form.description" type="textarea" /></el-form-item
      ><el-form-item label="图片地址" required
        ><el-input v-model="form.image" /></el-form-item
      ><img
        v-if="form.image"
        :src="form.image"
        alt="分类图片预览"
        class="admin-image-preview" /><el-form-item label="排序（越小越靠前）"
        ><el-input-number
          v-model="form.sort"
          :precision="0"
          :min="0" /></el-form-item></el-form
    ><template #footer
      ><el-button @click="dialog = false">取消</el-button
      ><el-button type="primary" :loading="pending" :disabled="busy" @click="save"
        >保存</el-button
      ></template
    ></el-dialog
  >
</template>
