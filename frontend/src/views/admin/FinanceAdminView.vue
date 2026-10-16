<script setup lang="ts">
import { computed, ref } from "vue";
import { useShop } from "../../stores/shop";
import { money, dateTime } from "../../domain/types";
import type { LedgerEntry } from "../../domain/types";
import { localDate } from "./useAdmin";
const shop = useShop(),
  range = ref<[string, string] | null>(null),
  type = ref("");
const labels = {
  payment: "模拟收款",
  refund: "模拟退款",
  purchase: "采购支出",
};
const rows = computed(() =>
  [...shop.db.ledger]
    .filter(
      (l) =>
        (!type.value || l.type === type.value) &&
        (!range.value ||
          (localDate(l.createdAt) >= range.value[0] &&
            localDate(l.createdAt) <= range.value[1])),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
);
const sums = computed(() => {
  const result = { payment: 0, refund: 0, purchase: 0 };
  for (const l of rows.value) result[l.type] += l.amount;
  return result;
});
function cell(value: unknown) {
  let str = String(value ?? "");
  if (/^[\s]*[=+\-@]/.test(str)) str = "'" + str;
  return '"' + str.replace(/"/g, '""') + '"';
}
function download() {
  const lines = [
    ["流水号", "类型", "金额（元）", "关联编号", "说明", "时间"],
    ...rows.value.map((l) => [
      l.id,
      labels[l.type],
      (l.amount / 100).toFixed(2),
      l.reference,
      l.note,
      dateTime(l.createdAt),
    ]),
  ];
  const blob = new Blob(
    ["\uFEFF" + lines.map((line) => line.map(cell).join(",")).join("\r\n")],
    { type: "text/csv;charset=utf-8" },
  );
  const url = URL.createObjectURL(blob),
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
    <el-button @click="download" :disabled="!rows.length"
      >导出当前 CSV</el-button
    >
  </div>
  <div class="admin-kpis">
    <div class="admin-kpi">
      <div class="admin-kpi-label">筛选范围净收支</div>
      <div class="admin-kpi-value">
        {{ money(sums.payment - sums.refund - sums.purchase) }}
      </div>
      <span class="admin-kpi-note">收款 − 退款 − 采购支出</span>
    </div>
    <div class="admin-kpi">
      <div class="admin-kpi-label">收款</div>
      <div class="admin-kpi-value">{{ money(sums.payment) }}</div>
      <span class="admin-kpi-note">已支付的模拟交易</span>
    </div>
    <div class="admin-kpi">
      <div class="admin-kpi-label">退款</div>
      <div class="admin-kpi-value">{{ money(sums.refund) }}</div>
      <span class="admin-kpi-note">已完成的售后退款</span>
    </div>
    <div class="admin-kpi">
      <div class="admin-kpi-label">采购支出</div>
      <div class="admin-kpi-value">{{ money(sums.purchase) }}</div>
      <span class="admin-kpi-note">补货时登记的总采购额</span>
    </div>
  </div>
  <section class="admin-panel">
    <div class="admin-toolbar">
      <el-date-picker
        v-model="range"
        type="daterange"
        value-format="YYYY-MM-DD"
        range-separator="至"
        start-placeholder="开始日期"
        end-placeholder="结束日期"
      /><el-select v-model="type" clearable placeholder="全部流水"
        ><el-option
          v-for="(label, key) in labels"
          :key="key"
          :label="label"
          :value="key" /></el-select
      ><span class="admin-note">{{ rows.length }} 条演示流水</span>
    </div>
    <el-table :data="rows" empty-text="当前范围暂无流水"
      ><el-table-column
        prop="id"
        label="流水编号"
        min-width="160"
      /><el-table-column label="类型" min-width="110"
        ><template #default="{ row }"
          ><el-tag
            :type="row.type === 'payment' ? 'success' : 'info'"
            effect="plain"
            >{{ labels[row.type as keyof typeof labels] }}</el-tag
          ></template
        ></el-table-column
      ><el-table-column
        label="金额"
        min-width="120"
        :sort-method="(a: LedgerEntry, b: LedgerEntry) => a.amount - b.amount"
        sortable
        ><template #default="{ row }"
          ><b
            >{{ row.type === "payment" ? "+" : "−" }}{{ money(row.amount) }}</b
          ></template
        ></el-table-column
      ><el-table-column
        prop="reference"
        label="关联编号"
        min-width="160"
      /><el-table-column
        prop="note"
        label="说明"
        min-width="180"
      /><el-table-column label="时间" min-width="170"
        ><template #default="{ row }">{{
          dateTime(row.createdAt)
        }}</template></el-table-column
      ></el-table
    >
  </section>
</template>
