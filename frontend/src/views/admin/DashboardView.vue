<script setup lang="ts">
import { computed, ref, watch, onUnmounted } from "vue";
import { RouterLink } from "vue-router";
import { useShop } from "../../stores/shop";
import { money, orderLabels, dateTime } from "../../domain/types";
import type { Order } from "../../domain/types";
import { request } from "../../services/repository";
interface Dashboard {
  orders: number | null;
  activeProducts: number;
  income: string | null;
  refund: string | null;
  purchase: string | null;
  net: string | null;
  tasks: { paid: number; requested: number; waiting: number };
  trend: { label: string; total: string }[];
  ranking: {
    id?: string;
    productId?: string;
    name: string;
    images?: string[];
    count?: number;
    quantity?: number;
  }[];
  lowStock: {
    productId: string;
    name: string;
    skuId: string;
    skuName: string;
    stock: number;
    available: number;
  }[];
  recentOrders: Order[];
}
const shop = useShop(),
  data = ref<Dashboard>(),
  error = ref("");
let sequence = 0;
async function load() {
  const current = ++sequence,
    actor = shop.adminSession?.id;
  try {
    const result = await request<Dashboard>("/api/admin/dashboard");
    if (current !== sequence || actor !== shop.adminSession?.id) return;
    data.value = result;
    error.value = "";
  } catch (cause) {
    if (current === sequence)
      error.value = cause instanceof Error ? cause.message : "读取经营汇总失败";
  }
}
watch(
  () => shop.db.revision,
  () => {
    void load();
  },
  { immediate: true },
);
watch(
  [
    () => shop.adminSession?.id,
    () => shop.adminSession?.permissions?.join(","),
  ],
  () => {
    sequence++;
    data.value = undefined;
    error.value = "";
    void load();
  },
  { flush: "sync" },
);
onUnmounted(() => {
  sequence++;
});
const permitted = (permission: string) =>
  shop.adminSession?.permissions?.includes(permission);
const income = computed(() => BigInt(data.value?.income ?? "0")),
  refund = computed(() => BigInt(data.value?.refund ?? "0"));
const lowStock = computed(() =>
  (data.value?.lowStock ?? []).map((row) => ({
    ...row,
    id: row.skuId,
    product: row.name,
    name: row.skuName,
  })),
);
const tasks = computed(() =>
  [
    {
      name: "待发货订单",
      count: data.value?.tasks.paid ?? 0,
      link: "/admin/orders?status=paid",
      permission: "warehouse",
    },
    {
      name: "待审核售后",
      count: data.value?.tasks.requested ?? 0,
      link: "/admin/after-sales?status=requested",
      permission: "support",
    },
    {
      name: "等待人工接入",
      count: data.value?.tasks.waiting ?? 0,
      link: "/admin/support?status=waiting",
      permission: "support",
    },
  ].filter((task) => permitted(task.permission)),
);
const trend = computed(() =>
  (data.value?.trend ?? []).map((row) => ({
    label: row.label,
    total: BigInt(row.total),
  })),
);
const max = computed(() =>
  trend.value.reduce(
    (value, row) => (row.total > value ? row.total : value),
    0n,
  ),
);
const chartY = (total: bigint) =>
  180 - Number((total * 150000n) / (max.value || 1n)) / 1000;
const points = computed(() =>
  trend.value
    .map((row, index) => `${20 + index * 100},${chartY(row.total)}`)
    .join(" "),
);
const ranking = computed(() =>
  (data.value?.ranking ?? []).map((row) => ({
    ...row,
    id: row.id ?? row.productId ?? row.name,
    images: row.images ?? [],
    count: row.count ?? row.quantity ?? 0,
  })),
);
</script>
<template>
  <el-alert
    v-if="error"
    :title="error"
    type="error"
    :closable="false"
  /><el-button v-if="error" @click="load">重新读取</el-button>
  <div class="admin-page-head">
    <div>
      <h1>经营概览</h1>
      <p>掌握生意进展，把每一笔订单照顾好。</p>
    </div>
    <el-tag effect="plain">模拟交易实时数据</el-tag>
  </div>
  <div class="admin-kpis">
    <div v-if="permitted('finance')" class="admin-kpi">
      <div class="admin-kpi-label">累计模拟收款</div>
      <div class="admin-kpi-value">{{ money(income) }}</div>
      <span class="admin-kpi-note">来自支付流水，不含未付款订单</span>
    </div>
    <div class="admin-kpi">
      <div class="admin-kpi-label">全部订单</div>
      <div class="admin-kpi-value">
        {{ data?.orders ?? "—" }}<small> 笔</small>
      </div>
      <span class="admin-kpi-note">包含取消与已退款订单</span>
    </div>
    <div v-if="permitted('finance')" class="admin-kpi">
      <div class="admin-kpi-label">累计退款</div>
      <div class="admin-kpi-value">{{ money(refund) }}</div>
      <span class="admin-kpi-note">已完成的模拟退款</span>
    </div>
    <div class="admin-kpi">
      <div class="admin-kpi-label">在售商品</div>
      <div class="admin-kpi-value">
        {{ data?.activeProducts ?? "—" }}<small> 件</small>
      </div>
      <span class="admin-kpi-note"
        >{{ lowStock.length }} 个 SKU 可售库存不足 6 件</span
      >
    </div>
  </div>
  <p v-if="permitted('finance') && data" class="admin-note">
    净收支 {{ money(BigInt(data.net ?? "0")) }}，采购支出
    {{ money(BigInt(data.purchase ?? "0")) }}；净收支不代表利润。
  </p>
  <div class="admin-two-column">
    <section v-if="permitted('finance')" class="admin-panel">
      <div class="admin-panel-head">
        <h2>近七日收款趋势</h2>
        <span class="admin-note">单位：元 · 支付流水原额，退款另计</span>
      </div>
      <svg
        class="admin-chart"
        viewBox="0 0 640 210"
        role="img"
        :aria-label="
          '近七日收款：' +
          trend.map((t) => t.label + ' ' + money(t.total)).join('，')
        "
      >
        <path d="M20 180 H620" stroke="#e9edf4" />
        <polyline
          :points="points"
          fill="none"
          stroke="#1a4be0"
          stroke-width="3"
        />
        <circle
          v-for="(t, i) in trend"
          :key="i"
          :cx="20 + i * 100"
          :cy="chartY(t.total)"
          r="4"
          fill="#1a4be0"
        />
        <text x="20" y="15" fill="#7b8492" font-size="12">
          峰值 {{ money(max) }}
        </text>
      </svg>
      <div class="admin-chart-labels">
        <span v-for="t in trend" :key="t.label"
          >{{ t.label }}<br />{{ money(t.total) }}</span
        >
      </div>
    </section>
    <section class="admin-panel">
      <div class="admin-panel-head">
        <h2>需要你处理</h2>
        <span class="admin-note">实时待办</span>
      </div>
      <RouterLink
        v-for="task in tasks"
        :key="task.name"
        class="admin-task-row"
        :to="task.link"
        ><span>{{ task.name }} ↗</span
        ><strong>{{ task.count }}</strong></RouterLink
      >
    </section>
  </div>
  <div class="admin-two-column">
    <section
      v-if="
        permitted('warehouse') || permitted('support') || permitted('finance')
      "
      class="admin-panel"
    >
      <div class="admin-panel-head">
        <h2>最近订单</h2>
        <RouterLink class="admin-text-button" to="/admin/orders"
          >查看全部 ↗</RouterLink
        >
      </div>
      <el-table :data="data?.recentOrders ?? []" empty-text="暂无订单"
        ><el-table-column label="订单号" min-width="140"
          ><template #default="{ row }"
            ><RouterLink
              :to="{ path: '/admin/orders', query: { detail: row.id } }"
              >{{ row.id }}</RouterLink
            ></template
          ></el-table-column
        ><el-table-column label="下单时间" min-width="155"
          ><template #default="{ row }">{{
            dateTime(row.createdAt)
          }}</template></el-table-column
        ><el-table-column label="订单金额" min-width="100"
          ><template #default="{ row }">{{
            money(row.total)
          }}</template></el-table-column
        ><el-table-column label="状态" width="95"
          ><template #default="{ row }"
            ><el-tag size="small" effect="plain">{{
              orderLabels[row.status as keyof typeof orderLabels]
            }}</el-tag></template
          ></el-table-column
        ></el-table
      >
    </section>
    <section class="admin-panel">
      <div class="admin-panel-head">
        <h2>热销商品</h2>
        <span class="admin-note">已支付件数，扣除实际退款数量</span>
      </div>
      <el-empty
        v-if="!ranking.length"
        description="暂无已支付且未退款的销量"
        :image-size="65"
      />
      <div class="admin-rank" v-for="p in ranking" :key="p.id">
        <img :src="p.images[0]" :alt="p.name" />
        <div>
          {{ p.name
          }}<small
            >{{ p.count }} 件
            <div class="admin-bar">
              <span
                :style="{
                  width:
                    (p.count / Math.max(ranking[0]?.count || 1, 1)) * 100 + '%',
                }"
              ></span></div
          ></small>
        </div>
      </div>
    </section>
  </div>
  <section
    v-if="permitted('warehouse') || permitted('catalog')"
    class="admin-panel"
  >
    <div class="admin-panel-head">
      <h2>低库存提醒</h2>
      <RouterLink
        v-if="permitted('warehouse')"
        class="admin-text-button"
        to="/admin/inventory?low=1"
        >前往补货 ↗</RouterLink
      >
    </div>
    <el-table :data="lowStock" empty-text="库存充足"
      ><el-table-column prop="product" label="商品" /><el-table-column
        prop="name"
        label="规格"
      /><el-table-column prop="stock" label="库存" sortable /><el-table-column
        label="建议"
        ><template #default="{ row }"
          ><RouterLink
            v-if="permitted('warehouse')"
            :to="{
              path: '/admin/inventory',
              query: { tab: 'stock', q: row.id },
            }"
            >核对并补货</RouterLink
          ></template
        ></el-table-column
      ></el-table
    >
  </section>
</template>
