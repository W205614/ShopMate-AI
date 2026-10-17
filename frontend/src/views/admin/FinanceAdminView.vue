<script setup lang="ts">
import { computed, ref, watch, nextTick } from "vue";
import type { TableInstance } from "element-plus";
import { useShop } from "../../stores/shop";
import { dateTime } from "../../domain/types";
import {
  ledgerLabels as labels,
  ledgerMoney,
  sumLedger,
  ledgerCsv,
  ledgerAssociation,
} from "../../domain/finance";
import { localDate } from "./useAdmin";
import { useAdminQuery, useAdminPagination } from "./useAdminList";
const shop = useShop(),
  filters = useAdminQuery();
const query = filters.field("q", { replace: true }),
  type = filters.field("type", { values: Object.keys(labels) }),
  from = filters.field("from"),
  to = filters.field("to"),
  sort = filters.field("sort", { values: ["asc", "desc"] }),
  selectedId = filters.field("detail", { resetPage: false }),
  detail = computed({
    get: () => !!selectedId.value,
    set: (v) => {
      if (!v) selectedId.value = "";
    },
  });
const range = computed<[string, string] | null>({
  get: (): [string, string] | null =>
    from.value && to.value ? [from.value, to.value] : null,
  set: (value: [string, string] | null) => {
    void filters
      .update({ from: value?.[0], to: value?.[1] }, { resetPage: true })
      .catch(() => undefined);
  },
});
const dateError = computed(() => {
  if (
    [from.value, to.value].some(
      (value) =>
        value &&
        (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
          localDate(new Date(`${value}T12:00:00`)) !== value),
    )
  )
    return "日期格式无效，请重新选择";
  return from.value && to.value && from.value > to.value
    ? "开始日期不能晚于结束日期"
    : "";
});
const filtered = computed(() =>
  [...shop.db.ledger]
    .filter(
      (l) =>
        !dateError.value &&
        (!type.value || l.type === type.value) &&
        (!from.value || localDate(l.createdAt) >= from.value) &&
        (!to.value || localDate(l.createdAt) <= to.value) &&
        (!query.value.trim() ||
          [l.id, l.reference, l.note, l.inventoryMovementId ?? ""].some(
            (value) =>
              value.toLowerCase().includes(query.value.trim().toLowerCase()),
          )),
    )
    .sort((a, b) =>
      sort.value
        ? (a.amount < b.amount
            ? -1
            : a.amount > b.amount
              ? 1
              : b.createdAt.localeCompare(a.createdAt) ||
                b.id.localeCompare(a.id)) * (sort.value === "desc" ? -1 : 1)
        : b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
    ),
);
const { page, rows } = useAdminPagination(filtered, filters);
const sums = computed(() => sumLedger(filtered.value));
const selected = computed(() =>
  shop.db.ledger.find((l) => l.id === selectedId.value),
);
const association = computed(
  () => selected.value && ledgerAssociation(selected.value, shop.db),
);
const table = ref<TableInstance>();
function sortChanged({ order }: { order: string | null }) {
  const value =
    order === "ascending" ? "asc" : order === "descending" ? "desc" : "";
  if (value !== sort.value) sort.value = value;
}
watch(sort, async () => {
  await nextTick();
  if (sort.value)
    table.value?.sort(
      "amount",
      sort.value === "asc" ? "ascending" : "descending",
    );
  else table.value?.clearSort();
});
function download() {
  const url = URL.createObjectURL(
      new Blob([ledgerCsv(filtered.value, dateTime)], {
        type: "text/csv;charset=utf-8",
      }),
    ),
    link = document.createElement("a");
  link.href = url;
  link.download = "ShopMate-演示流水.csv";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
</script>
<template>
  <div class="admin-page-head">
    <div>
      <h1>收支流水</h1>
      <p>记录每笔款项。净收支不代表利润。</p>
    </div>
    <el-button @click="download" :disabled="!filtered.length"
      >导出当前 CSV</el-button
    >
  </div>
  <div class="admin-kpis">
    <div class="admin-kpi">
      <div class="admin-kpi-label">筛选范围净收支</div>
      <div class="admin-kpi-value">
        {{ ledgerMoney(sums.payment - sums.refund - sums.purchase) }}
      </div>
      <span class="admin-kpi-note">收款 − 退款 − 采购支出</span>
    </div>
    <div class="admin-kpi">
      <div class="admin-kpi-label">收款</div>
      <div class="admin-kpi-value">{{ ledgerMoney(sums.payment) }}</div>
      <span class="admin-kpi-note">已支付的模拟交易</span>
    </div>
    <div class="admin-kpi">
      <div class="admin-kpi-label">退款</div>
      <div class="admin-kpi-value">{{ ledgerMoney(sums.refund) }}</div>
      <span class="admin-kpi-note">已完成的售后退款</span>
    </div>
    <div class="admin-kpi">
      <div class="admin-kpi-label">采购支出</div>
      <div class="admin-kpi-value">{{ ledgerMoney(sums.purchase) }}</div>
      <span class="admin-kpi-note">补货时登记的总采购额</span>
    </div>
  </div>
  <section class="admin-panel">
    <div class="admin-toolbar">
      <el-input
        v-model="query"
        placeholder="流水号 / 关联编号 / 说明"
        clearable
      />
      <el-date-picker
        v-model="range"
        popper-class="admin-date-range"
        :popper-options="{
          modifiers: [
            {
              name: 'preventOverflow',
              options: { altAxis: true, tether: false, padding: 12 },
            },
          ],
        }"
        type="daterange"
        value-format="YYYY-MM-DD"
        range-separator="至"
        start-placeholder="开始日期"
        end-placeholder="结束日期"
      />
      <el-select v-model="type" clearable placeholder="全部流水"
        ><el-option
          v-for="(label, key) in labels"
          :key="key"
          :label="label"
          :value="key"
      /></el-select>
      <el-button
        @click="
          filters.update(
            { q: '', type: '', from: '', to: '' },
            { resetPage: true },
          )
        "
        >重置筛选</el-button
      >
      <span class="admin-note">{{ filtered.length }} 条演示流水</span>
    </div>
    <p v-if="from || to" class="admin-note">
      当前日期：{{ from || "不限" }} 至
      {{ to || "不限" }}（浏览器本地日期，包含首尾日期）
    </p>
    <p class="admin-note">汇总和 CSV 包含全部筛选结果，不受当前页影响。</p>
    <el-alert
      v-if="dateError"
      :title="dateError"
      type="warning"
      :closable="false"
    />
    <el-table
      ref="table"
      :data="rows"
      :default-sort="{
        prop: 'amount',
        order:
          sort === 'asc'
            ? 'ascending'
            : sort === 'desc'
              ? 'descending'
              : undefined,
      }"
      @sort-change="sortChanged"
      empty-text="当前范围暂无流水"
    >
      <el-table-column prop="id" label="流水编号" min-width="180" />
      <el-table-column label="类型" min-width="110"
        ><template #default="{ row }"
          ><el-tag
            :type="row.type === 'payment' ? 'success' : 'info'"
            effect="plain"
            >{{ labels[row.type as keyof typeof labels] }}</el-tag
          ></template
        ></el-table-column
      >
      <el-table-column
        prop="amount"
        label="金额"
        min-width="150"
        sortable="custom"
        ><template #default="{ row }"
          ><b
            >{{ row.type === "payment" ? "+" : "−"
            }}{{ ledgerMoney(row.amount) }}</b
          ></template
        ></el-table-column
      >
      <el-table-column label="关联编号" min-width="240"
        ><template #default="{ row }"
          >{{ row.reference }}
          <div v-if="ledgerAssociation(row, shop.db).path">
            <RouterLink
              :to="{
                path: ledgerAssociation(row, shop.db).path,
                query: ledgerAssociation(row, shop.db).query,
              }"
              >{{ ledgerAssociation(row, shop.db).label }}</RouterLink
            >
          </div>
          <small class="admin-note">{{
            ledgerAssociation(row, shop.db).notice
          }}</small></template
        ></el-table-column
      >
      <el-table-column prop="note" label="说明" min-width="180" />
      <el-table-column label="时间" min-width="170"
        ><template #default="{ row }">{{
          dateTime(row.createdAt)
        }}</template></el-table-column
      >
      <el-table-column label="操作" width="100" fixed="right"
        ><template #default="{ row }"
          ><el-button link type="primary" @click="selectedId = row.id"
            >查看流水</el-button
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
  <el-dialog v-model="detail" title="流水详情" width="640px">
    <dl v-if="selected" class="admin-detail-list">
      <dt>流水编号</dt>
      <dd>{{ selected.id }}</dd>
      <dt>类型</dt>
      <dd>{{ labels[selected.type] }}</dd>
      <dt>金额</dt>
      <dd>{{ ledgerMoney(selected.amount) }}</dd>
      <dt>关联编号</dt>
      <dd>
        {{ selected.reference }}
        <p v-if="selected.inventoryMovementId">
          库存变动 {{ selected.inventoryMovementId }}
        </p>
        <p v-if="association?.path">
          <RouterLink
            :to="{ path: association.path, query: association.query }"
            >{{ association.label }}</RouterLink
          >
        </p>
        <p class="admin-note">{{ association?.notice }}</p>
      </dd>
      <dt>说明</dt>
      <dd>{{ selected.note }}</dd>
      <dt>时间</dt>
      <dd>{{ dateTime(selected.createdAt) }}</dd>
    </dl>
    <el-alert v-else title="没有找到该流水" type="warning" :closable="false" />
    <template #footer
      ><el-button @click="detail = false">关闭</el-button></template
    >
  </el-dialog>
</template>
