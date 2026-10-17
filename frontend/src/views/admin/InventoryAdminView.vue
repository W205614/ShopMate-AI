<script setup lang="ts">
import { computed, reactive, ref, watch, nextTick } from "vue";
import type { TableInstance } from "element-plus";
import { useShop } from "../../stores/shop";
import { api, RequestError, refreshState } from "../../services/api";
import { dateTime, money } from "../../domain/types";
import type { SKU } from "../../domain/types";
import { yuanToCents, centsToYuan } from "../../domain/amount";
import {
  readStockRecovery,
  saveStockRecovery,
  clearStockRecovery,
  type StockRecovery,
} from "../../services/stockRecovery";
import { useAdminAction } from "./useAdmin";
import { useAdminQuery, useAdminPagination } from "./useAdminList";
const shop = useShop(),
  { busy, pending, run } = useAdminAction(),
  filters = useAdminQuery();
const query = filters.field("q", { replace: true }),
  stockSort = filters.field("sort", { values: ["asc", "desc"] }),
  lowFilter = filters.field("low", { values: ["1"] }),
  low = computed({
    get: () => lowFilter.value === "1",
    set: (v) => {
      lowFilter.value = v ? "1" : "";
    },
  }),
  tabField = filters.field("tab", { values: ["stock", "records"] }),
  tab = computed({
    get: () => tabField.value || "stock",
    set: (v) => {
      tabField.value = v;
    },
  }),
  detailId = filters.field("detail", { resetPage: false }),
  detail = computed({
    get: () => !!detailId.value,
    set: (v) => {
      if (!v) detailId.value = "";
    },
  }),
  dialog = ref(false),
  conflict = ref(false),
  submitted = ref<StockRecovery | null>(null);
const stockTable = ref<TableInstance>();
function sortChanged({ order }: { order: string | null }) {
  const next =
    order === "ascending" ? "asc" : order === "descending" ? "desc" : "";
  if (next !== stockSort.value) stockSort.value = next;
}
watch([stockSort, tab], async () => {
  await nextTick();
  if (!stockTable.value) return;
  if (stockSort.value)
    stockTable.value.sort(
      "stock",
      stockSort.value === "asc" ? "ascending" : "descending",
    );
  else stockTable.value.clearSort();
});
const form = reactive({
  productId: "",
  skuId: "",
  name: "",
  stock: 0,
  mode: "delta" as "delta" | "count",
  quantity: 10,
  cost: "0.00",
  reason: "",
});
const stockRows = computed(() =>
  shop.db.products.flatMap((p) =>
    p.skus.map((s) => ({
      ...s,
      productId: p.id,
      product: p.name,
      image: p.images[0],
    })),
  ),
);
const match = (...values: string[]) =>
  !query.value.trim() ||
  values.some((value) =>
    value.toLowerCase().includes(query.value.trim().toLowerCase()),
  );
const stockFiltered = computed(() =>
  stockRows.value
    .filter(
      (s) =>
        match(s.productId, s.id, s.product, s.name) &&
        (!low.value || s.stock <= 5),
    )
    .sort((a, b) =>
      stockSort.value
        ? (a.stock - b.stock) * (stockSort.value === "desc" ? -1 : 1)
        : 0,
    ),
);
const movements = computed(() =>
  [...shop.db.inventory]
    .filter((m) =>
      match(
        m.id,
        m.productId,
        m.skuId,
        m.reason,
        stockRows.value.find(
          (s) => s.id === m.skuId && s.productId === m.productId,
        )?.product ?? "",
        stockRows.value.find(
          (s) => s.id === m.skuId && s.productId === m.productId,
        )?.name ?? "",
      ),
    )
    .sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
    ),
);
const filtered = computed(() =>
  tab.value === "stock" ? stockFiltered.value : movements.value,
);
const { page } = useAdminPagination<{ id: string }>(filtered, filters);
const rows = computed(() =>
  stockFiltered.value.slice((page.value - 1) * 10, page.value * 10),
);
const records = computed(() =>
  movements.value.slice((page.value - 1) * 10, page.value * 10),
);
const selectedMovement = computed(() =>
  shop.db.inventory.find((m) => m.id === detailId.value),
);
const matchedRequest = computed(
  () =>
    submitted.value &&
    shop.db.inventoryRequests.find(
      (r) =>
        r.adminId === shop.adminSession?.id &&
        r.requestId === submitted.value?.options.requestId,
    ),
);
const afterStock = computed(() =>
  form.mode === "count" ? form.quantity : form.stock + form.quantity,
);
const frozen = computed(() => pending.value || !!submitted.value);
function open(row: SKU & { productId: string; product: string }) {
  if (pending.value || submitted.value) return;
  Object.assign(form, {
    productId: row.productId,
    skuId: row.id,
    name: row.product + " · " + row.name,
    stock: row.stock,
    mode: "delta",
    quantity: 10,
    cost: "0.00",
    reason: "",
  });
  conflict.value = false;
  dialog.value = true;
}
watch(
  () => shop.adminSession?.id,
  (adminId) => {
    submitted.value = adminId ? readStockRecovery(adminId) : null;
    if (!submitted.value) {
      dialog.value = false;
      return;
    }
    const value = submitted.value;
    Object.assign(form, {
      productId: value.productId,
      skuId: value.skuId,
      name: value.name,
      stock: value.beforeStock,
      mode: value.options.mode ?? "delta",
      quantity: value.quantity,
      cost: centsToYuan(value.cost),
      reason: value.reason,
    });
    dialog.value = true;
  },
  { immediate: true },
);
watch(
  () => form.mode,
  () => {
    if (!submitted.value) {
      form.quantity = form.mode === "count" ? form.stock : 10;
      form.cost = "0.00";
    }
  },
);
async function loadLatest() {
  await run(async () => {
    const current = await refreshState("admin");
    const sku = current?.db.products
      .find((p) => p.id === form.productId)
      ?.skus.find((s) => s.id === form.skuId);
    if (!sku) throw new Error("商品或规格不可用，请关闭后重新核对");
    form.stock = sku.stock;
    conflict.value = false;
  }, "已加载最新库存，请核对实盘数量后重新确认");
}
function finish() {
  if (!submitted.value || !matchedRequest.value || pending.value || busy.value)
    return;
  clearStockRecovery(shop.adminSession!.id, submitted.value.options.requestId);
  submitted.value = null;
  dialog.value = false;
}
async function save() {
  const adminId = shop.adminSession?.id;
  if (!adminId || busy.value || conflict.value) return;
  if (matchedRequest.value) return finish();
  const success = await run(async () => {
    if (!submitted.value) {
      if (
        !form.reason.trim() ||
        form.reason.trim().length > 200 ||
        !Number.isSafeInteger(form.quantity) ||
        (form.mode === "count" ? form.quantity < 0 : form.quantity === 0) ||
        !Number.isSafeInteger(afterStock.value) ||
        afterStock.value < 0
      )
        throw new Error("请填写有效整数数量和原因，调整后库存不能为负数");
      const cost =
        form.mode === "delta" && form.quantity > 0
          ? yuanToCents(form.cost, 0)
          : 0;
      const value: StockRecovery = {
        productId: form.productId,
        skuId: form.skuId,
        name: form.name,
        beforeStock: form.stock,
        quantity: form.quantity,
        cost,
        reason: form.reason.trim(),
        options: {
          requestId: crypto.randomUUID(),
          mode: form.mode,
          ...(form.mode === "count" ? { expectedStock: form.stock } : {}),
        },
        createdAt: Date.now(),
      };
      saveStockRecovery(adminId, value);
      submitted.value = value;
    }
    const value = submitted.value;
    if (Date.now() - value.createdAt >= 86400000)
      throw new Error("请求恢复窗口已过，请核对库存变动记录后联系管理员处理");
    try {
      await api.adjustStock(
        value.productId,
        value.skuId,
        value.quantity,
        value.cost,
        value.reason,
        value.options,
      );
      clearStockRecovery(adminId, value.options.requestId);
      if (shop.adminSession?.id === adminId) submitted.value = null;
    } catch (error) {
      if (error instanceof RequestError && error.outcome === "rejected") {
        clearStockRecovery(adminId, value.options.requestId);
        if (shop.adminSession?.id === adminId) {
          submitted.value = null;
          conflict.value = error.status === 409;
        }
      }
      throw error;
    }
  }, "库存已调整，已记录流水");
  if (success && shop.adminSession?.id === adminId) dialog.value = false;
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
        name="records"
    /></el-tabs>
    <div class="admin-toolbar">
      <el-input
        v-model="query"
        placeholder="搜索商品、规格或变动编号 / 原因"
        clearable
      /><el-checkbox v-if="tab === 'stock'" v-model="low"
        >仅看低库存</el-checkbox
      ><el-button
        @click="filters.update({ q: '', low: '' }, { resetPage: true })"
        >重置筛选</el-button
      ><span class="admin-note">{{ filtered.length }} 条</span>
    </div>
    <el-table
      v-if="tab === 'stock'"
      ref="stockTable"
      @sort-change="sortChanged"
      :default-sort="{
        prop: 'stock',
        order:
          stockSort === 'asc'
            ? 'ascending'
            : stockSort === 'desc'
              ? 'descending'
              : undefined,
      }"
      :data="rows"
      empty-text="没有符合条件的库存"
    >
      <el-table-column label="商品" min-width="240"
        ><template #default="{ row }"
          ><div class="admin-product-cell">
            <img :src="row.image" :alt="row.product" /><span>{{
              row.product
            }}</span>
          </div></template
        ></el-table-column
      >
      <el-table-column prop="name" label="规格" min-width="140" />
      <el-table-column
        prop="stock"
        sortable="custom"
        label="可用库存"
        width="130"
        ><template #default="{ row }"
          ><el-tag :type="row.stock <= 5 ? 'danger' : 'info'" effect="plain"
            >{{ row.stock }} 件</el-tag
          ></template
        ></el-table-column
      >
      <el-table-column label="操作" width="150"
        ><template #default="{ row }"
          ><el-button
            type="primary"
            link
            :disabled="pending || !!submitted"
            @click="open(row)"
            >补货 / 调整</el-button
          ></template
        ></el-table-column
      >
    </el-table>
    <el-table v-else :data="records" empty-text="暂无库存变动">
      <el-table-column prop="id" label="变动编号" min-width="190" />
      <el-table-column label="商品 / SKU" min-width="230"
        ><template #default="{ row }"
          >{{
            stockRows.find(
              (s) => s.productId === row.productId && s.id === row.skuId,
            )?.product ?? row.productId
          }}<small style="display: block">{{
            stockRows.find(
              (s) => s.productId === row.productId && s.id === row.skuId,
            )?.name ?? row.skuId
          }}</small></template
        ></el-table-column
      >
      <el-table-column label="变动" width="100"
        ><template #default="{ row }"
          ><b :class="{ 'admin-danger': row.delta < 0 }"
            >{{ row.delta > 0 ? "+" : "" }}{{ row.delta }}</b
          ></template
        ></el-table-column
      >
      <el-table-column label="前后库存" min-width="130"
        ><template #default="{ row }">{{
          row.beforeStock === undefined
            ? "历史记录未保存"
            : `${row.beforeStock} → ${row.afterStock}`
        }}</template></el-table-column
      >
      <el-table-column prop="reason" label="原因" min-width="180" />
      <el-table-column label="时间" min-width="180"
        ><template #default="{ row }">{{
          dateTime(row.createdAt)
        }}</template></el-table-column
      >
      <el-table-column label="操作" width="100" fixed="right"
        ><template #default="{ row }"
          ><el-button link type="primary" @click="detailId = row.id"
            >查看变动</el-button
          ></template
        ></el-table-column
      >
    </el-table>
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
    title="调整库存"
    width="560px"
    :show-close="!frozen"
    :close-on-click-modal="!frozen"
    :close-on-press-escape="!frozen"
  >
    <p>{{ form.name }}</p>
    <p class="admin-note">
      读取时 {{ form.stock }} 件 → 调整后 {{ afterStock }} 件
    </p>
    <el-alert
      v-if="submitted"
      :title="
        matchedRequest
          ? '该请求已完成，请核对结果后关闭'
          : '结果未知：先重新同步核对记录，或按原请求重试，不能修改本次参数'
      "
      :type="matchedRequest ? 'success' : 'warning'"
      :closable="false"
    >
      <p>请求 {{ submitted.options.requestId }}</p>
      <p v-if="matchedRequest">
        {{ matchedRequest.result.beforeStock }} →
        {{ matchedRequest.result.afterStock }} 件 · 变动
        {{ matchedRequest.result.movementId }}
      </p>
      <el-button
        link
        :disabled="pending"
        @click="refreshState('admin').catch(() => undefined)"
        >重新同步库存记录</el-button
      >
    </el-alert>
    <el-alert
      v-if="conflict"
      title="库存已变化，请重新读取并核对，目标数量和说明已保留"
      type="warning"
      :closable="false"
      ><el-button link :disabled="busy" @click="loadLatest"
        >加载最新库存</el-button
      ></el-alert
    >
    <el-form label-position="top" @submit.prevent="save">
      <el-form-item label="调整方式"
        ><el-radio-group v-model="form.mode" :disabled="frozen"
          ><el-radio value="delta">增减调整</el-radio
          ><el-radio value="count">盘点实际库存</el-radio></el-radio-group
        ></el-form-item
      >
      <el-form-item v-if="form.mode === 'count'" label="实盘数量" required
        ><el-input-number
          v-model="form.quantity"
          aria-label="实盘数量"
          :precision="0"
          :min="0"
          :disabled="frozen"
      /></el-form-item>
      <el-form-item v-else label="调整数量（正数补货，负数盘亏）" required
        ><el-input-number
          v-model="form.quantity"
          aria-label="调整数量（正数补货，负数盘亏）"
          :precision="0"
          :min="-form.stock"
          :disabled="frozen"
      /></el-form-item>
      <el-form-item
        v-if="form.mode === 'delta' && form.quantity > 0"
        label="本次采购总支出（元，0 表示无采购成本）"
        ><el-input
          v-model="form.cost"
          aria-label="本次采购总支出（元，0 表示无采购成本）"
          inputmode="decimal"
          :disabled="frozen"
      /></el-form-item>
      <p v-if="form.mode === 'count'" class="admin-note">
        按实盘数量校正库存，不生成采购支出；期间销售或退货改变库存时需重新核对。
      </p>
      <el-form-item label="变动原因" required
        ><el-input
          v-model="form.reason"
          type="textarea"
          maxlength="200"
          placeholder="例如：到货入库 / 盘点修正"
          :disabled="frozen"
      /></el-form-item>
    </el-form>
    <template #footer
      ><el-button :disabled="frozen" @click="dialog = false">取消</el-button
      ><el-button
        v-if="matchedRequest"
        type="primary"
        :disabled="busy"
        @click="finish"
        >确认已完成并关闭</el-button
      ><el-button
        v-else
        type="primary"
        :loading="pending"
        :disabled="busy || conflict"
        @click="save"
        >{{ submitted ? "按原请求重试" : "确认调整" }}</el-button
      ></template
    >
  </el-dialog>
  <el-dialog v-model="detail" title="库存变动详情" width="600px">
    <dl v-if="selectedMovement" class="admin-detail-list">
      <dt>变动编号</dt>
      <dd>{{ selectedMovement.id }}</dd>
      <dt>商品 / SKU</dt>
      <dd>{{ selectedMovement.productId }} / {{ selectedMovement.skuId }}</dd>
      <dt>数量</dt>
      <dd>
        {{ selectedMovement.delta }} ·
        {{
          selectedMovement.beforeStock === undefined
            ? "历史记录未保存前后库存"
            : `${selectedMovement.beforeStock} → ${selectedMovement.afterStock}`
        }}
      </dd>
      <dt>方式</dt>
      <dd>
        {{
          selectedMovement.mode === "count"
            ? "实盘校正（不计采购）"
            : selectedMovement.mode === "delta"
              ? "增减调整"
              : "历史/业务变动"
        }}
      </dd>
      <dt>原因</dt>
      <dd>{{ selectedMovement.reason }}</dd>
      <dt>时间</dt>
      <dd>{{ dateTime(selectedMovement.createdAt) }}</dd>
      <dt>关联采购</dt>
      <dd>
        {{
          shop.db.ledger
            .filter((l) => l.inventoryMovementId === selectedMovement?.id)
            .map((l) => money(l.amount))
            .join("、") || "无精确关联的采购支出"
        }}
      </dd>
    </dl>
    <el-alert
      v-else
      title="没有找到该库存变动"
      type="warning"
      :closable="false"
    />
    <template #footer
      ><el-button @click="detail = false">关闭</el-button></template
    >
  </el-dialog>
</template>
