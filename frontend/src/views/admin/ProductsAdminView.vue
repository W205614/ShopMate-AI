<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { ElMessageBox, ElMessage } from "element-plus";
import { useShop } from "../../stores/shop";
import { api } from "../../services/api";
import type { Product, ProductInput } from "../../domain/types";
import { money } from "../../domain/types";
import { useAdminAction } from "./useAdmin";
const shop = useShop(),
  { busy, pending, run } = useAdminAction(),
  query = ref(""),
  category = ref(""),
  status = ref(""),
  dialog = ref(false),
  page = ref(1);
const form = reactive<ProductInput>({
    name: "",
    subtitle: "",
    categoryId: "",
    description: "",
    images: [],
    skus: [],
    active: true,
    featured: false,
    material: "",
  }),
  imageText = ref("");
const filtered = computed(() =>
  shop.db.products.filter(
    (p) =>
      (!query.value || p.name.includes(query.value)) &&
      (!category.value || p.categoryId === category.value) &&
      (!status.value || String(p.active) === status.value),
  ),
);
const rows = computed(() =>
  filtered.value.slice((page.value - 1) * 10, page.value * 10),
);
const minPrice = (product: Product) => Math.min(...product.skus.map(s => s.price));
const totalStock = (product: Product) => product.skus.reduce((total, sku) => total + sku.stock, 0);
function open(p?: Product) {
  Object.assign(
    form,
    p
      ? JSON.parse(JSON.stringify(p))
      : {
          id: undefined,
          name: "",
          subtitle: "",
          categoryId: shop.db.categories[0]?.id || "",
          description: "",
          images: [],
          skus: [{ id: "", name: "标准款", price: 9900, stock: 0 }],
          active: true,
          featured: false,
          material: "",
        },
  );
  imageText.value = form.images.join("\n");
  dialog.value = true;
}
async function save() {
  if (
    !form.name.trim() ||
    !form.subtitle.trim() ||
    !form.material.trim() ||
    !form.categoryId ||
    !form.description.trim() ||
    !imageText.value.trim() ||
    !form.skus.length ||
    form.skus.some(
      (s) =>
        !s.name.trim() ||
        s.price < 1 ||
        !Number.isInteger(s.price) ||
        s.stock < 0 ||
        !Number.isInteger(s.stock),
    )
  ) {
    await run(async () => {
      throw Error(
        "请完整填写商品名称、副标题、材质、分类、描述、图片和有效 SKU；价格以分填写，至少 1 分",
      );
    });
    return;
  }
  const input = {
    ...form,
    images: imageText.value
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
    skus: form.skus.map((s) => ({ ...s })),
  };
  if (await run(() => api.saveProduct(input), "商品已保存"))
    dialog.value = false;
}
async function upload(event: Event) {
  const files = (event.target as HTMLInputElement).files;
  if (!files) return;
  for (const file of Array.from(files)) {
    if (
      !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
      file.size > 2 * 1024 * 1024
    ) {
      ElMessage.error("请上传 2 MB 内的 PNG、JPEG 或 WebP 图片");
      continue;
    }
    const value = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    imageText.value = [imageText.value.trim(), value]
      .filter(Boolean)
      .join("\n");
  }
}
async function toggle(p: Product) {
  try {
    await ElMessageBox.confirm(
      `确认${p.active ? "下架" : "上架"}「${p.name}」？`,
      "商品状态",
      { type: "warning" },
    );
    await run(() => api.toggleProduct(p.id), "商品状态已更新");
  } catch {
    /* dismissed */
  }
}
</script>
<template>
  <div class="admin-page-head">
    <div>
      <h1>商品管理</h1>
      <p>维护商品内容、规格与售价。</p>
    </div>
    <el-button type="primary" @click="open()">新建商品</el-button>
  </div>
  <section class="admin-panel">
    <div class="admin-toolbar">
      <el-input
        v-model="query"
        placeholder="搜索商品名称"
        clearable
        @input="page = 1"
      /><el-select
        v-model="category"
        clearable
        placeholder="全部分类"
        @change="page = 1"
        ><el-option
          v-for="c in shop.db.categories"
          :key="c.id"
          :label="c.name"
          :value="c.id" /></el-select
      ><el-select
        v-model="status"
        clearable
        placeholder="全部状态"
        @change="page = 1"
        ><el-option label="已上架" value="true" /><el-option
          label="已下架"
          value="false" /></el-select
      ><span class="admin-note">共 {{ filtered.length }} 件商品</span>
    </div>
    <el-table :data="rows" empty-text="没有符合条件的商品"
      ><el-table-column label="商品" min-width="260"
        ><template #default="{ row }"
          ><div class="admin-product-cell">
            <img :src="row.images[0]" :alt="row.name" />
            <div>
              {{ row.name }}<small>{{ row.subtitle }}</small>
            </div>
          </div></template
        ></el-table-column
      ><el-table-column label="分类" min-width="110"
        ><template #default="{ row }">{{
          shop.db.categories.find((c) => c.id === row.categoryId)?.name
        }}</template></el-table-column
      ><el-table-column
        label="起售价"
        min-width="110"
        :sort-method="
          (a: Product, b: Product) =>
            Math.min(...a.skus.map((s) => s.price)) -
            Math.min(...b.skus.map((s) => s.price))
        "
        sortable
        ><template #default="{ row }">{{
          money(minPrice(row))
        }}</template></el-table-column
      ><el-table-column label="库存" width="90"
        ><template #default="{ row }">{{
          totalStock(row)
        }}</template></el-table-column
      ><el-table-column label="状态" width="100"
        ><template #default="{ row }"
          ><el-tag :type="row.active ? 'success' : 'info'" effect="plain">{{
            row.active ? "已上架" : "已下架"
          }}</el-tag></template
        ></el-table-column
      ><el-table-column label="操作" width="150" fixed="right"
        ><template #default="{ row }"
          ><el-button link type="primary" @click="open(row)">编辑</el-button
          ><el-button
            link
            :type="row.active ? 'danger' : 'primary'"
            :loading="pending" :disabled="busy"
            @click="toggle(row)"
            >{{ row.active ? "下架" : "上架" }}</el-button
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
    :title="form.id ? '编辑商品' : '新建商品'"
    width="760px"
    :close-on-click-modal="false"
    ><el-form label-position="top" @submit.prevent="save"
      ><div class="admin-form-grid">
        <el-form-item label="商品名称" required
          ><el-input v-model="form.name" maxlength="60" /></el-form-item
        ><el-form-item label="所属分类" required
          ><el-select v-model="form.categoryId"
            ><el-option
              v-for="c in shop.db.categories"
              :key="c.id"
              :label="c.name"
              :value="c.id" /></el-select></el-form-item
        ><el-form-item label="副标题" required
          ><el-input v-model="form.subtitle" /></el-form-item
        ><el-form-item label="材质 / 产品说明" required
          ><el-input v-model="form.material" /></el-form-item
        ><el-form-item label="商品描述" required class="wide"
          ><el-input
            v-model="form.description"
            type="textarea"
            :rows="3" /></el-form-item
        ><el-form-item
          label="图片地址（每行一张，仅支持 /images/... 或上传图片）"
          required
          class="wide"
          ><el-input v-model="imageText" type="textarea" :rows="2" /><input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            aria-label="上传商品图片"
            style="margin-top: 12px"
            @change="upload" />
          <div style="margin-top: 12px">
            <img
              v-for="src in imageText.split('\n').filter(Boolean)"
              :key="src"
              class="admin-image-preview"
              :src="src"
              alt="商品图片预览"
            /></div
        ></el-form-item>
      </div>
      <div class="admin-split-heading">
        <h2>规格与售价</h2>
        <el-button
          @click="form.skus.push({ id: '', name: '', price: 100, stock: 0 })"
          >新增 SKU</el-button
        >
      </div>
      <p class="admin-note">
        价格以分填写（100 = ¥1.00）。现有库存通过库存管理调整，保留变动记录。
      </p>
      <div class="admin-sku-row" v-for="(sku, i) in form.skus" :key="i">
        <div><small>规格名称</small><el-input v-model="sku.name" /></div>
        <div>
          <small>售价（分）</small
          ><el-input-number v-model="sku.price" :min="1" :precision="0" />
        </div>
        <div>
          <small>{{ sku.id ? "当前库存（只读）" : "初始库存" }}</small
          ><el-input-number
            v-model="sku.stock"
            :disabled="!!sku.id"
            :min="0"
            :precision="0"
          />
        </div>
        <el-button
          type="danger"
          link
          style="margin-top: 27px"
          :disabled="!!sku.id || form.skus.length === 1"
          @click="form.skus.splice(i, 1)"
          >移除</el-button
        >
      </div>
      <el-form-item
        ><el-checkbox v-model="form.active">上架销售</el-checkbox
        ><el-checkbox v-model="form.featured"
          >推荐商品</el-checkbox
        ></el-form-item
      ></el-form
    ><template #footer
      ><el-button @click="dialog = false">取消</el-button
      ><el-button type="primary" :loading="pending" :disabled="busy" @click="save"
        >保存商品</el-button
      ></template
    ></el-dialog
  >
</template>
