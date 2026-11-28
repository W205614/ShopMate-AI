<script setup lang="ts">
import { useCommerceMode } from "../../services/commerceMode";
const { production } = useCommerceMode();
import { computed, onMounted, ref, reactive, watch } from "vue";
import { useShop } from "../../stores/shop";
import { api } from "../../services/api";
import { request } from "../../services/repository";
import type { Warehouse } from "../../../../shared/domain/warehouses";
import {
  orderLabels,
  afterSaleLabels,
  money,
  dateTime,
} from "../../domain/types";
import type { Order } from "../../domain/types";
import { useAdminAction, localDate } from "./useAdmin";
import { useAdminQuery, useAdminPagination, waitAge } from "./useAdminList";
import TaskWaitFilter from "../../components/admin/TaskWaitFilter.vue";
import { eventLabel } from "../../components/shop/commerceLabels";
import { canOpenAdminPath } from "../../router";
import "../../styles/commerce-flow.css";
const totalQuantity = (order: Order) =>
  order.items.reduce((total, item) => total + item.quantity, 0);
const refundedQuantity = (order: Order) =>
  order.items.reduce((sum, item) => sum + item.refundedQuantity, 0);
const remainingQuantity = (order: Order) =>
  totalQuantity(order) - refundedQuantity(order);
const paymentRecorded = (order: Order) =>
  !!order.paidAt ||
  ["paid", "shipped", "completed", "refunded"].includes(order.status);
const filters = useAdminQuery();
const shop = useShop(),
  { busy, pending, run } = useAdminAction(),
  query = filters.field("q", { replace: true }),
  status = filters.field("status", { values: Object.keys(orderLabels) }),
  wait = filters.field("wait", { values: ["all", "soon", "overdue"] }),
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
  form = reactive({
    id: "",
    carrier: "顺丰速运（模拟）",
    tracking: "",
    warehouseId: "",
  });
const warehouses = ref<Warehouse[]>([]);
const eligibleLines = computed(
  () =>
    shippingOrder.value?.allocations?.filter(
      (allocation) =>
        allocation.warehouseId === form.warehouseId &&
        remainingAllocation(allocation) > 0,
    ) ?? [],
);
const shippingOrder = computed(() =>
  shop.db.orders.find((order) => order.id === form.id),
);
const shippingWarehouses = computed(() => [
  ...new Set(
    shippingOrder.value?.allocations
      ?.filter((allocation) => remainingAllocation(allocation) > 0)
      .map((allocation) => allocation.warehouseId) ?? [],
  ),
]);
const quantities = reactive<Record<string, number>>({});
const changing = ref(false);
const reassignment = reactive({
  orderId: "",
  allocationId: "",
  warehouseId: "",
  quantity: 1,
  maximum: 1,
  source: "",
});
const warehouseName = (id: string) =>
  warehouses.value.find((warehouse) => warehouse.id === id)?.name ??
  (id === "warehouse-default" ? "默认仓" : id);
function remainingAllocation(
  allocation: NonNullable<Order["allocations"]>[number],
) {
  return allocation.quantity - allocation.shipped - allocation.cancelled;
}
watch(eligibleLines, (lines) => {
  for (const line of lines) quantities[line.id] = remainingAllocation(line);
});
onMounted(() => {
  if (shop.adminSession?.permissions?.includes("warehouse"))
    void run(async () => {
      warehouses.value = (
        await request<{ warehouses: Warehouse[] }>("/api/admin/warehouses")
      ).warehouses;
    });
});
const showDelivery = computed(() =>
  shop.adminSession?.permissions?.some(
    (permission) => permission === "warehouse" || permission === "support",
  ),
);
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
            o.address?.name ?? "",
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
const { page, rows, total } = useAdminPagination(filtered, filters);
const selected = computed(() =>
  shop.db.orders.find((o) => o.id === selectedId.value),
);
function canShip(order: Order) {
  return (
    shop.adminSession?.permissions?.includes("warehouse") &&
    order.status === "paid" &&
    (order.allocations
      ? order.allocations.some(
          (allocation) => remainingAllocation(allocation) > 0,
        )
      : order.items.some((item) => item.quantity > item.refundedQuantity) &&
        !shop.db.afterSales.some(
          (a) =>
            a.orderId === order.id &&
            !["refunded", "rejected", "cancelled"].includes(a.status),
        ))
  );
}
function view(o: Order) {
  selectedId.value = o.id;
}
function shipping(o: Order) {
  if (busy.value || !canShip(o)) return;
  form.id = o.id;
  form.carrier =
    o.transactionMode === "production" ? "顺丰速运" : "顺丰速运（模拟）";
  form.tracking = "";
  form.warehouseId = shippingWarehouses.value[0] ?? "";
  ship.value = true;
}
async function submit() {
  if (!form.carrier.trim() || !form.tracking.trim())
    return void run(async () => {
      throw Error("请填写物流公司和单号");
    });
  if (
    await run(
      async () => {
        if (!shippingOrder.value?.allocations)
          return api.shipOrder(form.id, form.carrier, form.tracking);
        await api.shipParcel(form.id, {
          warehouseId: form.warehouseId,
          carrier: form.carrier.trim(),
          tracking: form.tracking.trim(),
          lines: eligibleLines.value
            .filter((line) => quantities[line.id]! > 0)
            .map((line) => ({
              allocationId: line.id,
              quantity: quantities[line.id]!,
            })),
        });
      },
      production.value ? "发货信息已登记" : "模拟发货已完成",
    )
  )
    ship.value = false;
}
function reassign(
  order: Order,
  allocation: NonNullable<Order["allocations"]>[number],
) {
  const maximum = remainingAllocation(allocation);
  Object.assign(reassignment, {
    orderId: order.id,
    allocationId: allocation.id,
    source: allocation.warehouseId,
    warehouseId: "",
    quantity: maximum,
    maximum,
  });
  changing.value = true;
}
async function submitReassignment() {
  if (
    await run(
      () =>
        api.reassignWarehouse(
          reassignment.orderId,
          reassignment.allocationId,
          reassignment.warehouseId,
          reassignment.quantity,
        ),
      "待发商品已改派",
    )
  )
    changing.value = false;
}
</script>
<template>
  <div class="admin-page-head">
    <div>
      <h1>订单管理</h1>
      <p>从付款到收货，跟进每一笔订单。</p>
    </div>
    <el-tag effect="plain">{{
      production ? "请登记真实运单" : "物流为模拟信息"
    }}</el-tag>
  </div>
  <section class="admin-panel">
    <div class="admin-toolbar">
      <el-input
        v-model="query"
        maxlength="100"
        :placeholder="showDelivery ? '订单号 / 商品 / 收件人' : '订单号 / 商品'"
        clearable
      /><el-select v-model="status" placeholder="全部状态" clearable
        ><el-option
          v-for="(label, key) in orderLabels"
          :key="key"
          :label="label"
          :value="key"
      /></el-select>
      <TaskWaitFilter
        v-if="
          status === 'paid' &&
          shop.adminSession?.permissions?.includes('warehouse')
        "
        v-model="wait"
      />
      <label class="admin-filter-date"
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
            { q: '', status: '', from: '', to: '', wait: '' },
            { resetPage: true },
          )
        "
        >重置筛选</el-button
      >
      <span class="admin-note">{{ total }} 笔订单</span>
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
      /><el-table-column
        v-if="wait && status === 'paid'"
        label="等待时长"
        min-width="115"
      >
        <template #default="{ row }">{{
          waitAge(row.paidAt)
        }}</template> </el-table-column
      ><el-table-column
        :label="showDelivery ? '用户 / 收件人' : '用户'"
        min-width="150"
        ><template #default="{ row }"
          >{{ shop.db.users.find((u) => u.id === row.userId)?.name
          }}<small v-if="row.address" style="display: block; color: #7a828f">{{
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
        :total="total"
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
        <template v-if="selected.address">
          <dt>收件信息</dt>
          <dd>
            {{ selected.address.name }} · {{ selected.address.phone }}<br />{{
              selected.address.region
            }}
            {{ selected.address.detail }}
          </dd>
          <dt>物流信息</dt>
          <dd>{{ selected.carrier || "尚未发货" }} {{ selected.tracking }}</dd>
        </template>
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
        v-if="selected.status === 'paid' && canShip(selected)"
        class="admin-note"
      >
        仓储待发货。登记承运商和运单后，订单进入待收货。
      </p>
      <p
        v-if="selected.status === 'paid' && !canShip(selected)"
        class="admin-note"
      >
        {{
          shop.adminSession?.permissions?.includes("warehouse")
            ? "有进行中的售后或无剩余商品，暂不可发货。"
            : "当前角色可查看订单；发货请由仓储或店主处理。"
        }}
      </p>
      <p class="admin-note">
        未退数量为购买数量减已退款数量；是否可发货由订单与售后状态决定。
      </p>
      <div class="admin-stats-line">
        {{
          paymentRecorded(selected)
            ? "实付金额"
            : selected.status === "pending"
              ? "应付金额"
              : "订单金额"
        }}
        <strong>{{ money(selected.total) }}</strong
        ><span v-if="selected.discount"
          >（优惠 {{ money(selected.discount) }}）</span
        ><span v-if="selected.refundedAmount">
          · 已退 {{ money(selected.refundedAmount) }}</span
        >
        <span v-if="!paymentRecorded(selected)"> · 未付款</span>
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
      <p
        v-if="
          canOpenAdminPath(
            '/admin/reviews',
            shop.adminSession?.permissions ?? [],
          )
        "
      >
        <RouterLink
          :to="{ path: '/admin/reviews', query: { orderId: selected.id } }"
          >查看该订单评价</RouterLink
        >
      </p> </template
    ><el-alert v-else title="没有找到该订单" type="warning" :closable="false" />
    <section
      v-if="selected?.allocations?.length && showDelivery"
      class="admin-panel"
    >
      <h3>分仓与包裹</h3>
      <div v-for="allocation in selected.allocations" :key="allocation.id">
        {{ warehouseName(allocation.warehouseId) }} ·
        {{
          selected.items.find((item) => item.id === allocation.orderItemId)
            ?.skuName
        }}
        · 待发 {{ remainingAllocation(allocation) }} / 已发
        {{ allocation.shipped }} / 已取消 {{ allocation.cancelled }}
        <el-button
          v-if="
            canShip(selected) &&
            remainingAllocation(allocation) &&
            warehouses.length > 1
          "
          link
          type="primary"
          :disabled="busy"
          @click="reassign(selected, allocation)"
          >改派</el-button
        >
      </div>
      <p v-for="parcel in selected.parcels ?? []" :key="parcel.id">
        {{ warehouseName(parcel.warehouseId) }} · {{ parcel.carrier }}
        {{ parcel.tracking }} · {{ parcel.receivedAt ? "已收货" : "已发货" }}
      </p>
    </section>
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
    :title="production ? '登记发货' : '模拟发货'"
    width="480px"
    :close-on-click-modal="!pending"
    :close-on-press-escape="!pending"
    :show-close="!pending"
    ><el-alert
      :title="
        production
          ? '请在线下完成寄件，再录入实际承运商与单号。'
          : '仅更新演示状态，不会向物流公司创建运单。'
      "
      type="info"
      :closable="false"
    /><el-form label-position="top" :disabled="busy" @submit.prevent="submit"
      ><template v-if="shippingOrder?.allocations">
        <el-form-item label="发货仓"
          ><el-select v-model="form.warehouseId">
            <el-option
              v-for="warehouseId in shippingWarehouses"
              :key="warehouseId"
              :value="warehouseId"
              :label="warehouseName(warehouseId)"
            /> </el-select
        ></el-form-item>
        <el-form-item
          v-for="line in eligibleLines"
          :key="line.id"
          :label="`发货件数 · ${shippingOrder.items.find((item) => item.id === line.orderItemId)?.skuName}`"
        >
          <el-input-number
            v-model="quantities[line.id]"
            :min="0"
            :max="remainingAllocation(line)"
            :precision="0"
          />
        </el-form-item> </template
      ><el-form-item label="物流公司" required
        ><el-input v-model="form.carrier" /></el-form-item
      ><el-form-item label="物流单号" required
        ><el-input
          v-model="form.tracking"
          :placeholder="
            production ? '输入实际物流单号' : '输入演示物流单号'
          " /></el-form-item></el-form
    ><template #footer
      ><el-button :disabled="pending" @click="ship = false">取消</el-button
      ><el-button
        type="primary"
        :loading="pending"
        :disabled="busy"
        @click="submit"
        >{{ production ? "确认登记发货" : "确认模拟发货" }}</el-button
      ></template
    ></el-dialog
  >
  <el-dialog
    v-model="changing"
    title="改派未发商品"
    width="440px"
    :close-on-click-modal="false"
  >
    <el-form
      label-position="top"
      :disabled="busy"
      @submit.prevent="submitReassignment"
    >
      <el-form-item label="目标仓"
        ><el-select v-model="reassignment.warehouseId">
          <el-option
            v-for="warehouse in warehouses.filter(
              (entry) =>
                entry.id !== reassignment.source && entry.acceptsOrders,
            )"
            :key="warehouse.id"
            :value="warehouse.id"
            :label="warehouse.name"
          /> </el-select
      ></el-form-item>
      <el-form-item label="改派件数"
        ><el-input-number
          v-model="reassignment.quantity"
          :min="1"
          :max="reassignment.maximum"
          :precision="0"
      /></el-form-item>
      <el-button
        native-type="submit"
        type="primary"
        :disabled="busy || !reassignment.warehouseId"
        >确认改派</el-button
      >
    </el-form>
  </el-dialog>
</template>
