<script setup lang="ts">
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { useShop } from "../../stores/shop";
import { localDate } from "./useAdmin";
import { money, orderLabels, dateTime } from "../../domain/types";
const shop = useShop();
const income = computed(() =>
  shop.db.ledger
    .filter((l) => l.type === "payment")
    .reduce((n, l) => n + l.amount, 0),
);
const refund = computed(() =>
  shop.db.ledger
    .filter((l) => l.type === "refund")
    .reduce((n, l) => n + l.amount, 0),
);
const lowStock = computed(() =>
  shop.db.products.flatMap((p) =>
    p.skus.filter((s) => s.stock <= 5).map((s) => ({ ...s, product: p.name })),
  ),
);
const tasks = computed(() => [
  {
    name: "待发货订单",
    count: shop.db.orders.filter((o) => o.status === "paid").length,
    link: "/admin/orders",
  },
  {
    name: "待审核售后",
    count: shop.db.afterSales.filter((a) => a.status === "requested").length,
    link: "/admin/after-sales",
  },
  {
    name: "等待人工接入",
    count: shop.db.conversations.filter((c) => c.status === "waiting").length,
    link: "/admin/support",
  },
]);
const trend = computed(() =>
  Array.from({ length: 7 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - 6 + i);
    const key = localDate(d);
    return {
      label: `${d.getMonth() + 1}/${d.getDate()}`,
      total: shop.db.ledger
        .filter((l) => l.type === "payment" && localDate(l.createdAt) === key)
        .reduce((n, l) => n + l.amount, 0),
    };
  }),
);
const max = computed(() => Math.max(...trend.value.map((t) => t.total), 1));
const points = computed(() =>
  trend.value
    .map((t, i) => `${20 + i * 100},${180 - (t.total / max.value) * 150}`)
    .join(" "),
);
const ranking = computed(() =>
  shop.db.products
    .map((p) => {
      const count = shop.db.orders
        .filter((o) =>
          ["paid", "shipped", "completed", "refunded"].includes(o.status),
        )
        .flatMap((o) => o.items)
        .filter((i) => i.productId === p.id)
        .reduce((n, i) => n + i.quantity - i.refundedQuantity, 0);
      return { ...p, count };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 4),
);
</script>
<template>
  <div class="admin-page-head">
    <div>
      <h1>经营概览</h1>
      <p>掌握生意进展，把每一笔订单照顾好。</p>
    </div>
    <el-tag effect="plain">演示数据</el-tag>
  </div>
  <div class="admin-kpis">
    <div class="admin-kpi">
      <div class="admin-kpi-label">累计模拟收款</div>
      <div class="admin-kpi-value">{{ money(income) }}</div>
      <span class="admin-kpi-note">来自支付流水，不含未付款订单</span>
    </div>
    <div class="admin-kpi">
      <div class="admin-kpi-label">全部订单</div>
      <div class="admin-kpi-value">
        {{ shop.db.orders.length }}<small> 笔</small>
      </div>
      <span class="admin-kpi-note">包含取消与已退款订单</span>
    </div>
    <div class="admin-kpi">
      <div class="admin-kpi-label">累计退款</div>
      <div class="admin-kpi-value">{{ money(refund) }}</div>
      <span class="admin-kpi-note">已完成的模拟退款</span>
    </div>
    <div class="admin-kpi">
      <div class="admin-kpi-label">在售商品</div>
      <div class="admin-kpi-value">
        {{ shop.db.products.filter((p) => p.active).length }}<small> 件</small>
      </div>
      <span class="admin-kpi-note"
        >{{ lowStock.length }} 个 SKU 库存不足 6 件</span
      >
    </div>
  </div>
  <div class="admin-two-column">
    <section class="admin-panel">
      <div class="admin-panel-head">
        <h2>近七日收款趋势</h2>
        <span class="admin-note">单位：元 · 演示数据</span>
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
          :cy="180 - (t.total / max) * 150"
          r="4"
          fill="#1a4be0"
        />
        <text x="20" y="15" fill="#7b8492" font-size="12">
          峰值 {{ money(max === 1 ? 0 : max) }}
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
    <section class="admin-panel">
      <div class="admin-panel-head">
        <h2>最近订单</h2>
        <RouterLink class="admin-text-button" to="/admin/orders"
          >查看全部 ↗</RouterLink
        >
      </div>
      <el-table
        :data="
          [...shop.db.orders]
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .slice(0, 5)
        "
        empty-text="暂无订单"
        ><el-table-column
          prop="id"
          label="订单号"
          min-width="140"
        /><el-table-column label="下单时间" min-width="155"
          ><template #default="{ row }">{{
            dateTime(row.createdAt)
          }}</template></el-table-column
        ><el-table-column label="实付金额" min-width="100"
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
        <span class="admin-note">按已支付订单件数</span>
      </div>
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
  <section class="admin-panel">
    <div class="admin-panel-head">
      <h2>低库存提醒</h2>
      <RouterLink class="admin-text-button" to="/admin/inventory"
        >前往补货 ↗</RouterLink
      >
    </div>
    <el-table :data="lowStock" empty-text="库存充足"
      ><el-table-column prop="product" label="商品" /><el-table-column
        prop="name"
        label="规格"
      /><el-table-column prop="stock" label="库存" sortable /><el-table-column
        label="建议"
        ><template #default>请核对库存后补货</template></el-table-column
      ></el-table
    >
  </section>
</template>
