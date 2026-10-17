<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { ElMessageBox } from "element-plus";
import { useShop } from "../../stores/shop";
import { api } from "../../services/api";
import type { Product, ProductInput } from "../../domain/types";
import { money } from "../../domain/types";
import { useAdminAction } from "./useAdmin";
import ImageEditor from "../../components/admin/ImageEditor.vue";
import { validateDecodedImages } from "../../services/images";
import { yuanToCents, centsToYuan } from "../../domain/amount";
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
  priceInputs = ref<string[]>([]),
  imageBusy = ref(false);
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
watch(
  () => filtered.value.length,
  (length) => {
    page.value = Math.min(page.value, Math.max(1, Math.ceil(length / 10)));
  },
);
const minPrice = (product: Product) =>
  Math.min(...product.skus.map((s) => s.price));
const totalStock = (product: Product) =>
  product.skus.reduce((total, sku) => total + sku.stock, 0);
function open(p?: Product) {
  if (pending.value || imageBusy.value) return;
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
  priceInputs.value = form.skus.map((s) => centsToYuan(s.price));
  dialog.value = true;
}
async function save() {
  if (imageBusy.value) return;
  if (
    await run(async () => {
      if (
        !form.name.trim() ||
        !form.subtitle.trim() ||
        !form.material.trim() ||
        !form.categoryId ||
        !form.description.trim() ||
        !form.skus.length ||
        form.skus.some(
          (s) =>
            !s.name.trim() || !Number.isSafeInteger(s.stock) || s.stock < 0,
        )
      )
        throw new Error("请完整填写商品信息和有效规格库存");
      const input = {
        ...form,
        images: [...form.images],
        skus: form.skus.map((s, index) => ({
          ...s,
          price: yuanToCents(priceInputs.value[index] ?? ""),
        })),
      };
      await validateDecodedImages(input.images);
      await api.saveProduct(input);
    }, "商品已保存")
  )
    dialog.value = false;
}
function addSku() {
  form.skus.push({ id: "", name: "", price: 100, stock: 0 });
  priceInputs.value.push("1.00");
}
function removeSku(index: number) {
  form.skus.splice(index, 1);
  priceInputs.value.splice(index, 1);
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
    <el-button type="primary" :disabled="pending || imageBusy" @click="open()"
      >新建商品</el-button
    >
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
          ><el-button
            link
            type="primary"
            :disabled="pending || imageBusy"
            @click="open(row)"
            >编辑</el-button
          ><el-button
            link
            :type="row.active ? 'danger' : 'primary'"
            :loading="pending"
            :disabled="busy"
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
    :close-on-press-escape="!pending && !imageBusy"
    :show-close="!pending && !imageBusy"
    ><el-form
      label-position="top"
      :disabled="busy || imageBusy"
      @submit.prevent="save"
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
        ><el-form-item label="商品图片" required class="wide"
          ><ImageEditor
            v-model="form.images"
            label="商品图片"
            :disabled="busy"
            @busy="imageBusy = $event"
        /></el-form-item>
      </div>
      <div class="admin-split-heading">
        <h2>规格与售价</h2>
        <el-button :disabled="busy || imageBusy" @click="addSku"
          >新增 SKU</el-button
        >
      </div>
      <p class="admin-note">
        售价以元填写，最多两位小数；保存为整数分。现有库存通过库存管理调整，保留变动记录。
      </p>
      <div class="admin-sku-row" v-for="(sku, i) in form.skus" :key="i">
        <div><small>规格名称</small><el-input v-model="sku.name" /></div>
        <div>
          <small>售价（元）</small
          ><el-input
            v-model="priceInputs[i]"
            aria-label="售价（元）"
            inputmode="decimal"
          />
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
          :disabled="busy || imageBusy || !!sku.id || form.skus.length === 1"
          @click="removeSku(i)"
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
      ><el-button :disabled="pending || imageBusy" @click="dialog = false"
        >取消</el-button
      ><el-button
        type="primary"
        :loading="pending"
        :disabled="busy || imageBusy"
        @click="save"
        >保存商品</el-button
      ></template
    ></el-dialog
  >
</template>
