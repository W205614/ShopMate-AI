<script setup lang="ts">
import { computed, ref, reactive } from "vue";
import { useShop } from "../../stores/shop";
import { api } from "../../services/api";
import { orderLabels, money, dateTime } from "../../domain/types";
import type { Order } from "../../domain/types";
const totalQuantity = (order: Order) =>
  order.items.reduce((total, item) => total + item.quantity, 0);
import { useAdminAction } from "./useAdmin";
const shop = useShop(),
  { busy, pending, run } = useAdminAction(),
  query = ref(""),
  status = ref(""),
  selectedId = ref(""),
  detail = ref(false),
  ship = ref(false),
  form = reactive({ id: "", carrier: "顺丰速运（模拟）", tracking: "" });
const rows = computed(() =>
  [...shop.db.orders]
    .filter(
      (o) =>
        (!query.value ||
          o.id.includes(query.value) ||
          o.address.name.includes(query.value)) &&
        (!status.value || o.status === status.value),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
);
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
  detail.value = true;
}
function shipping(o: Order) {
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
        placeholder="订单号 / 收件人"
        clearable
      /><el-select v-model="status" placeholder="全部状态" clearable
        ><el-option
          v-for="(label, key) in orderLabels"
          :key="key"
          :label="label"
          :value="key" /></el-select
      ><span class="admin-note">{{ rows.length }} 笔订单</span>
    </div>
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
            >共
            {{ totalQuantity(row) }}
            件</small
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
            type="primary"
            link
            @click="shipping(row)"
            >发货</el-button
          ></template
        ></el-table-column
      ></el-table
    >
  </section>
  <el-dialog v-model="detail" title="订单详情" width="700px"
    ><template v-if="selected"
      ><dl class="admin-detail-list">
        <dt>订单编号</dt>
        <dd>{{ selected.id }}</dd>
        <dt>订单状态</dt>
        <dd>{{ orderLabels[selected.status] }}</dd>
        <dt>下单时间</dt>
        <dd>{{ dateTime(selected.createdAt) }}</dd>
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
      <div
        class="admin-order-product"
        v-for="i in selected.items"
        :key="i.skuId"
      >
        <img :src="i.image" :alt="i.name" />
        <div>
          {{ i.name
          }}<small style="display: block"
            >{{ i.skuName }} × {{ i.quantity
            }}<span v-if="i.refundedQuantity">
              · 已退 {{ i.refundedQuantity }} 件 / 剩余
              {{ i.quantity - i.refundedQuantity }} 件</span
            ></small
          >
        </div>
        <b>{{ money(i.total) }}</b>
      </div>
      <div class="admin-stats-line">
        实付金额 <strong>{{ money(selected.total) }}</strong
        ><span v-if="selected.discount"
          >（优惠 {{ money(selected.discount) }}）</span
        ><span v-if="selected.refundedAmount">
          · 已退 {{ money(selected.refundedAmount) }}</span
        >
      </div></template
    ><template #footer
      ><el-button @click="detail = false">关闭</el-button
      ><el-button
        v-if="selected && canShip(selected)"
        type="primary"
        @click="shipping(selected)"
        >填写发货信息</el-button
      ></template
    ></el-dialog
  ><el-dialog v-model="ship" title="模拟发货" width="480px"
    ><el-alert
      title="仅更新演示状态，不会向物流公司创建运单。"
      type="info"
      :closable="false"
    /><el-form label-position="top" @submit.prevent="submit"
      ><el-form-item label="物流公司" required
        ><el-input v-model="form.carrier" /></el-form-item
      ><el-form-item label="物流单号" required
        ><el-input
          v-model="form.tracking"
          placeholder="输入演示物流单号" /></el-form-item></el-form
    ><template #footer
      ><el-button @click="ship = false">取消</el-button
      ><el-button type="primary" :loading="pending" :disabled="busy" @click="submit"
        >确认模拟发货</el-button
      ></template
    ></el-dialog
  >
</template>
