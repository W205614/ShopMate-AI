<script setup lang="ts">
import { computed, ref, reactive } from "vue";
import { useShop } from "../../stores/shop";
import { api } from "../../services/api";
import {
  orderLabels,
  afterSaleLabels,
  money,
  dateTime,
} from "../../domain/types";
import type { Order } from "../../domain/types";
import { useAdminAction, localDate } from "./useAdmin";
import { useAdminQuery, useAdminPagination } from "./useAdminList";
import { eventLabel } from "../../components/shop/commerceLabels";
import "../../styles/commerce-flow.css";
const totalQuantity = (order: Order) =>
  order.items.reduce((total, item) => total + item.quantity, 0);
const refundedQuantity = (order: Order) =>
  order.items.reduce((sum, item) => sum + item.refundedQuantity, 0);
const remainingQuantity = (order: Order) =>
  totalQuantity(order) - refundedQuantity(order);
const filters = useAdminQuery();
const shop = useShop(),
  { busy, pending, run } = useAdminAction(),
  query = filters.field("q", { replace: true }),
  status = filters.field("status", { values: Object.keys(orderLabels) }),
  from = filters.field("from"),
  to = filters.field("to"),
  selectedId = filters.field("detail", { resetPage: false }),
  detail = computed({
    get: () => !!selectedId.value,
    set: (value) => {
      if (!value) selectedId.value = "";
    },
  }),
  ship = ref(false),
  form = reactive({ id: "", carrier: "顺丰速运（模拟）", tracking: "" });
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
  [...shop.db.orders]
    .filter(
      (o) =>
        !dateError.value &&
        (!query.value.trim() ||
          [
            o.id,
            o.address.name,
            ...o.items.map((i) => `${i.name} ${i.skuName}`),
          ].some((value) =>
            value.toLowerCase().includes(query.value.trim().toLowerCase()),
          )) &&
        (!status.value || o.status === status.value) &&
        (!from.value || localDate(o.createdAt) >= from.value) &&
        (!to.value || localDate(o.createdAt) <= to.value),
    )
    .sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
    ),
);
const { page, rows } = useAdminPagination(filtered, filters);
const selected = computed(() =>
  shop.db.orders.find((o) => o.id === selectedId.value),
);
function canShip(order: Order) {
  return (
    order.status === "paid" &&
    order.items.some((item) => item.quantity > item.refundedQuantity) &&
    !shop.db.afterSales.some(
      (a) =>
        a.orderId === order.id &&
        !["refunded", "rejected", "cancelled"].includes(a.status),
    )
  );
}
function view(o: Order) {
  selectedId.value = o.id;
}
function shipping(o: Order) {
  if (busy.value || !canShip(o)) return;
  form.id = o.id;
  form.tracking = "";
  ship.value = true;
}
async function submit() {
  if (!form.carrier.trim() || !form.tracking.trim())
    return void run(async () => {
      throw Error("请填写物流公司和单号");
    });
  if (
    await run(
      () => api.shipOrder(form.id, form.carrier, form.tracking),
      "模拟发货已完成",
    )
  )
    ship.value = false;
}
</script>
<template>
  <div class="admin-page-head">
    <div>
      <h1>订单管理</h1>
      <p>从付款到收货，跟进每一笔订单。</p>
    </div>
    <el-tag effect="plain">物流为模拟信息</el-tag>
  </div>
  <section class="admin-panel">
    <div class="admin-toolbar">
      <el-input
        v-model="query"
        placeholder="订单号 / 商品 / 收件人"
        clearable
      /><el-select v-model="status" placeholder="全部状态" clearable
        ><el-option
          v-for="(label, key) in orderLabels"
          :key="key"
          :label="label"
          :value="key" /></el-select
      ><label class="admin-filter-date"
        >下单开始日期<el-input
          v-model="from"
          type="date"
          aria-label="下单开始日期"
      /></label>
      <label class="admin-filter-date"
        >下单结束日期<el-input
          v-model="to"
          type="date"
          aria-label="下单结束日期"
      /></label>
      <el-button
        @click="
          filters.update(
            { q: '', status: '', from: '', to: '' },
            { resetPage: true },
          )
        "
        >重置筛选</el-button
      >
      <span class="admin-note">{{ filtered.length }} 笔订单</span>
    </div>
    <el-alert
      v-if="dateError"
      :title="dateError"
      type="error"
      :closable="false"
    />
    <el-table :data="rows" empty-text="暂无符合条件的订单"
      ><el-table-column
        prop="id"
        label="订单号"
        min-width="180"
      /><el-table-column label="用户 / 收件人" min-width="150"
        ><template #default="{ row }"
          >{{ shop.db.users.find((u) => u.id === row.userId)?.name
          }}<small style="display: block; color: #7a828f">{{
            row.address.name
          }}</small></template
        ></el-table-column
      ><el-table-column label="商品" min-width="190"
        ><template #default="{ row }"
          >{{ row.items[0]?.name
          }}<small style="display: block; color: #7a828f"
            >购买 {{ totalQuantity(row) }} 件 · 已退
            {{ refundedQuantity(row) }} 件 · 未退
            {{ remainingQuantity(row) }} 件</small
          ></template
        ></el-table-column
      ><el-table-column label="金额" min-width="110"
        ><template #default="{ row }"
          >{{ money(row.total)
          }}<small
            v-if="row.refundedAmount"
            style="display: block; color: #7a828f"
            >已退 {{ money(row.refundedAmount) }}</small
          ></template
        ></el-table-column
      ><el-table-column label="状态" width="100"
        ><template #default="{ row }"
          ><el-tag effect="plain">{{
            orderLabels[row.status as keyof typeof orderLabels]
          }}</el-tag></template
        ></el-table-column
      ><el-table-column label="下单时间" min-width="170"
        ><template #default="{ row }">{{
          dateTime(row.createdAt)
        }}</template></el-table-column
      ><el-table-column label="操作" fixed="right" width="130"
        ><template #default="{ row }"
          ><el-button type="primary" link @click="view(row)">详情</el-button
          ><el-button
            v-if="canShip(row)"
            :disabled="busy"
            type="primary"
            link
            @click="shipping(row)"
            >发货</el-button
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
    v-model="detail"
    title="订单详情"
    width="700px"
    :close-on-click-modal="!pending"
    :close-on-press-escape="!pending"
    :show-close="!pending"
    ><template v-if="selected"
      ><dl class="admin-detail-list">
        <dt>订单编号</dt>
        <dd>{{ selected.id }}</dd>
        <dt>订单状态</dt>
        <dd>{{ orderLabels[selected.status] }}</dd>
        <dt>下单时间</dt>
        <dd>{{ dateTime(selected.createdAt) }}</dd>
        <template v-if="selected.paidAt"
          ><dt>付款时间</dt>
          <dd>{{ dateTime(selected.paidAt) }}</dd></template
        >
        <template v-if="selected.shippedAt"
          ><dt>发货时间</dt>
          <dd>{{ dateTime(selected.shippedAt) }}</dd></template
        >
        <template v-if="selected.completedAt"
          ><dt>收货时间</dt>
          <dd>{{ dateTime(selected.completedAt) }}</dd></template
        >
        <template v-if="selected.cancelledAt"
          ><dt>关闭时间</dt>
          <dd>
            {{ dateTime(selected.cancelledAt) }} · {{ selected.cancelReason }}
          </dd></template
        >
        <dt>收件信息</dt>
        <dd>
          {{ selected.address.name }} · {{ selected.address.phone }}<br />{{
            selected.address.region
          }}
          {{ selected.address.detail }}
        </dd>
        <dt>物流信息</dt>
        <dd>{{ selected.carrier || "尚未发货" }} {{ selected.tracking }}</dd>
      </dl>
      <div class="admin-order-product" v-for="i in selected.items" :key="i.id">
        <img :src="i.image" :alt="i.name" />
        <div>
          {{ i.name
          }}<small style="display: block"
            >{{ i.skuName }} · 购买 {{ i.quantity }} 件 · 已退
            {{ i.refundedQuantity }} 件 · 未退
            {{ i.quantity - i.refundedQuantity }} 件</small
          >
        </div>
        <b>{{ money(i.total) }}</b>
      </div>
      <p>
        待发货数量：{{
          selected.status === "paid" ? remainingQuantity(selected) : 0
        }}
        件
      </p>
      <p
        v-if="selected.status === 'paid' && !canShip(selected)"
        class="admin-note"
      >
        有进行中的售后或无剩余商品，暂不可发货。
      </p>
      <p class="admin-note">
        未退数量为购买数量减已退款数量；是否可发货由订单与售后状态决定。
      </p>
      <div class="admin-stats-line">
        实付金额 <strong>{{ money(selected.total) }}</strong
        ><span v-if="selected.discount"
          >（优惠 {{ money(selected.discount) }}）</span
        ><span v-if="selected.refundedAmount">
          · 已退 {{ money(selected.refundedAmount) }}</span
        >
      </div>
      <h3>已记录的订单进度</h3>
      <ol v-if="selected.events.length" class="commerce-timeline">
        <li v-for="(event, index) in selected.events" :key="index">
          <strong>{{ eventLabel(event.action) }}</strong
          ><span v-if="event.note"> · {{ event.note }}</span
          ><time
            >{{ dateTime(event.at) }} ·
            {{
              event.actor === "admin"
                ? "管理员"
                : event.actor === "user"
                  ? "用户"
                  : "系统"
            }}</time
          >
        </li>
      </ol>
      <p v-else class="admin-note">该历史订单未记录更多进度时间。</p>
      <h3>售后记录</h3>
      <p
        v-for="sale in shop.db.afterSales.filter(
          (a) => a.orderId === selected?.id,
        )"
        :key="sale.id"
      >
        <RouterLink
          :to="{
            path: '/admin/after-sales',
            query: { orderId: selected.id, detail: sale.id },
          }"
          >{{ sale.id }} · {{ afterSaleLabels[sale.status] }}</RouterLink
        >
      </p>
      <RouterLink
        :to="{ path: '/admin/after-sales', query: { orderId: selected.id } }"
        >查看该订单全部售后</RouterLink
      >
      <p>
        <RouterLink
          :to="{ path: '/admin/reviews', query: { orderId: selected.id } }"
          >查看该订单评价</RouterLink
        >
      </p> </template
    ><el-alert v-else title="没有找到该订单" type="warning" :closable="false" />
    <template #footer
      ><el-button :disabled="pending" @click="detail = false">关闭</el-button
      ><el-button
        v-if="selected && canShip(selected)"
        :disabled="busy"
        type="primary"
        @click="shipping(selected)"
        >填写发货信息</el-button
      ></template
    ></el-dialog
  ><el-dialog
    v-model="ship"
    title="模拟发货"
    width="480px"
    :close-on-click-modal="!pending"
    :close-on-press-escape="!pending"
    :show-close="!pending"
    ><el-alert
      title="仅更新演示状态，不会向物流公司创建运单。"
      type="info"
      :closable="false"
    /><el-form label-position="top" :disabled="busy" @submit.prevent="submit"
      ><el-form-item label="物流公司" required
        ><el-input v-model="form.carrier" /></el-form-item
      ><el-form-item label="物流单号" required
        ><el-input
          v-model="form.tracking"
          placeholder="输入演示物流单号" /></el-form-item></el-form
    ><template #footer
      ><el-button :disabled="pending" @click="ship = false">取消</el-button
      ><el-button
        type="primary"
        :loading="pending"
        :disabled="busy"
        @click="submit"
        >确认模拟发货</el-button
      ></template
    ></el-dialog
  >
</template>
