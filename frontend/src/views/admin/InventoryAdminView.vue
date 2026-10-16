<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { useShop } from "../../stores/shop";
import { api } from "../../services/api";
import { dateTime } from "../../domain/types";
import type { SKU } from "../../domain/types";
import { useAdminAction } from "./useAdmin";
const shop = useShop(),
  { busy, run } = useAdminAction(),
  query = ref(""),
  low = ref(false),
  dialog = ref(false),
  tab = ref("stock");
const form = reactive({
  productId: "",
  skuId: "",
  name: "",
  stock: 0,
  delta: 10,
  cost: 0,
  reason: "",
});
const rows = computed(() =>
  shop.db.products
    .flatMap((p) =>
      p.skus.map((s) => ({
        ...s,
        productId: p.id,
        product: p.name,
        image: p.images[0],
      })),
    )
    .filter(
      (s) =>
        (!query.value ||
          s.product.includes(query.value) ||
          s.name.includes(query.value)) &&
        (!low.value || s.stock <= 5),
    ),
);
function open(row: SKU & { productId: string; product: string }) {
  Object.assign(form, {
    productId: row.productId,
    skuId: row.id,
    name: row.product + " · " + row.name,
    stock: row.stock,
    delta: 10,
    cost: 0,
    reason: "",
  });
  dialog.value = true;
}
async function save() {
  if (
    !form.reason.trim() ||
    !form.delta ||
    !Number.isInteger(form.delta) ||
    form.stock + form.delta < 0 ||
    form.cost < 0 ||
    !Number.isInteger(form.cost)
  )
    return void run(async () => {
      throw Error("请填写原因和非零整数调整量，调整后库存不能为负数");
    });
  if (
    await run(
      () =>
        api.adjustStock(
          form.productId,
          form.skuId,
          form.delta,
          form.delta > 0 ? form.cost : 0,
          form.reason,
        ),
      "库存已调整，已记录流水",
    )
  )
    dialog.value = false;
}
</script>
<template>
  <div class="admin-page-head">
    <div>
      <h1>库存管理</h1>
      <p>每一次库存变化，都有迹可循。</p>
    </div>
    <el-tag effect="plain">低库存阈值 ≤ 5</el-tag>
  </div>
  <section class="admin-panel">
    <el-tabs v-model="tab"
      ><el-tab-pane label="SKU 库存" name="stock" /><el-tab-pane
        label="变动记录"
        name="records" /></el-tabs
    ><template v-if="tab === 'stock'"
      ><div class="admin-toolbar">
        <el-input
          v-model="query"
          placeholder="搜索商品或规格"
          clearable
        /><el-checkbox v-model="low">仅看低库存</el-checkbox>
      </div>
      <el-table :data="rows" empty-text="没有符合条件的库存"
        ><el-table-column label="商品" min-width="240"
          ><template #default="{ row }"
            ><div class="admin-product-cell">
              <img :src="row.image" :alt="row.product" /><span>{{
                row.product
              }}</span>
            </div></template
          ></el-table-column
        ><el-table-column
          prop="name"
          label="规格"
          min-width="140"
        /><el-table-column prop="stock" sortable label="可用库存" width="130"
          ><template #default="{ row }"
            ><el-tag :type="row.stock <= 5 ? 'danger' : 'info'" effect="plain"
              >{{ row.stock }} 件</el-tag
            ></template
          ></el-table-column
        ><el-table-column label="操作" width="150"
          ><template #default="{ row }"
            ><el-button type="primary" link @click="open(row)"
              >补货 / 调整</el-button
            ></template
          ></el-table-column
        ></el-table
      ></template
    ><el-table
      v-else
      :data="
        [...shop.db.inventory].sort((a, b) =>
          b.createdAt.localeCompare(a.createdAt),
        )
      "
      empty-text="暂无库存变动"
      ><el-table-column label="商品 / SKU" min-width="230"
        ><template #default="{ row }"
          >{{
            shop.db.products.find((p) => p.id === row.productId)?.name ||
            row.productId
          }}<small style="display: block">{{
            shop.db.products
              .find((p) => p.id === row.productId)
              ?.skus.find((s) => s.id === row.skuId)?.name || row.skuId
          }}</small></template
        ></el-table-column
      ><el-table-column label="变动" width="110"
        ><template #default="{ row }"
          ><b :class="{ 'admin-danger': row.delta < 0 }"
            >{{ row.delta > 0 ? "+" : "" }}{{ row.delta }}</b
          ></template
        ></el-table-column
      ><el-table-column
        prop="reason"
        label="原因"
        min-width="180"
      /><el-table-column label="时间" min-width="180"
        ><template #default="{ row }">{{
          dateTime(row.createdAt)
        }}</template></el-table-column
      ></el-table
    >
  </section>
  <el-dialog v-model="dialog" title="调整库存" width="520px"
    ><p>{{ form.name }}</p>
    <p class="admin-note">
      当前 {{ form.stock }} 件 → 调整后 {{ form.stock + form.delta }} 件
    </p>
    <el-form label-position="top" @submit.prevent="save"
      ><el-form-item label="调整数量（正数补货，负数盘亏）" required
        ><el-input-number
          v-model="form.delta"
          :precision="0"
          :min="-form.stock" /></el-form-item
      ><el-form-item
        v-if="form.delta > 0"
        label="本次采购总支出（分，0 表示无采购成本）"
        ><el-input-number
          v-model="form.cost"
          :precision="0"
          :min="0" /></el-form-item
      ><el-form-item label="变动原因" required
        ><el-input
          v-model="form.reason"
          type="textarea"
          placeholder="例如：到货入库 / 盘点修正" /></el-form-item></el-form
    ><template #footer
      ><el-button @click="dialog = false">取消</el-button
      ><el-button type="primary" :loading="busy" @click="save"
        >确认调整</el-button
      ></template
    ></el-dialog
  >
</template>
