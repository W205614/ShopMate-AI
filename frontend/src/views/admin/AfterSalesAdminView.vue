<script setup lang="ts">
import { computed, ref, watch, onUnmounted } from "vue";
import { ElMessageBox } from "element-plus";
import { useShop } from "../../stores/shop";
import { api } from "../../services/api";
import { afterSaleLabels, money, dateTime } from "../../domain/types";
import type { AfterSale } from "../../domain/types";
import { useAdminAction } from "./useAdmin";
import { useAdminQuery, useAdminPagination } from "./useAdminList";
import { afterSaleState } from "../../domain/afterSaleState";
import { eventLabel } from "../../components/shop/commerceLabels";
import "../../styles/account-commerce.css";
const filters = useAdminQuery();
const shop = useShop(),
  { busy, pending, run } = useAdminAction(),
  query = filters.field("q", { replace: true }),
  orderId = filters.field("orderId"),
  status = filters.field("status", { values: Object.keys(afterSaleLabels) }),
  selectedId = filters.field("detail", { resetPage: false }),
  dialog = computed({
    get: () => !!selectedId.value,
    set: (value) => {
      if (!value) selectedId.value = "";
    },
  }),
  confirming = ref(false),
  note = ref(""),
  baselineNote = ref("");
let cancelConfirmation: (() => void) | undefined;
const filtered = computed(() =>
  [...shop.db.afterSales]
    .filter(
      (a) =>
        (!status.value || a.status === status.value) &&
        (!orderId.value || a.orderId === orderId.value) &&
        (!query.value.trim() ||
          [a.id, a.orderId].some((value) =>
            value.toLowerCase().includes(query.value.trim().toLowerCase()),
          )),
    )
    .sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
    ),
);
const { page, rows, total } = useAdminPagination(filtered, filters);
const selected = computed(() =>
  shop.db.afterSales.find((a) => a.id === selectedId.value),
);
const selectedOrder = computed(() =>
  shop.db.orders.find((o) => o.id === selected.value?.orderId),
);
const state = computed(() =>
  selected.value ? afterSaleState(selected.value, selectedOrder.value) : null,
);
const actionPermissions = {
  approve: "support",
  reject: "support",
  receive: "warehouse",
  refund: "finance",
} as const;
const permitted = (type: keyof typeof actionPermissions) =>
  !!shop.adminSession?.permissions?.includes(actionPermissions[type]);
const allowedActions = computed(() => ({
  approve: !!state.value?.canApprove && permitted("approve"),
  reject: !!state.value?.canReject && permitted("reject"),
  receive: !!state.value?.canReceive && permitted("receive"),
  refund: !!state.value?.canRefund && permitted("refund"),
}));
const assignment = computed(() => {
  if (state.value?.canApprove && !permitted("approve"))
    return "当前申请待客服审核，请由客服或店主批准或拒绝。";
  if (state.value?.canReceive && !permitted("receive"))
    return "当前退货待仓储确认收货，请由仓储或店主处理。";
  if (state.value?.canRefund && !permitted("refund"))
    return "当前申请待财务退款，请由财务或店主处理。";
  return "";
});
function loadLatestNote() {
  note.value = baselineNote.value = selected.value?.note ?? "";
}
const noteConflict = computed(
  () =>
    baselineNote.value !== (selected.value?.note ?? "") &&
    note.value !== baselineNote.value &&
    note.value !== selected.value?.note,
);
watch(
  () => [selected.value?.id, selected.value?.note] as const,
  ([id], previous) => {
    if (id !== previous?.[0]) {
      cancelConfirmation?.();
      loadLatestNote();
    } else if (
      note.value === baselineNote.value ||
      note.value === selected.value?.note
    ) {
      loadLatestNote();
    }
  },
  { immediate: true },
);
let alive = true;
onUnmounted(() => {
  alive = false;
  cancelConfirmation?.();
});
function open(a: AfterSale) {
  if (pending.value || confirming.value) return;
  selectedId.value = a.id;
}
async function action(type: "approve" | "reject" | "receive" | "refund") {
  if (!selected.value || busy.value || confirming.value) return;
  if (!permitted(type))
    return void (await run(async () => {
      throw new Error("当前员工没有此操作权限，请由对应角色处理");
    }));
  const sale = selected.value,
    inputNote = note.value;
  if (!allowedActions.value[type])
    return void (await run(async () => {
      throw new Error(state.value?.guidance ?? "申请状态不可处理");
    }));
  const labels = {
    approve: "批准申请",
    reject: "拒绝申请",
    receive: "确认收到退货",
    refund: "执行模拟退款",
  };
  if (type === "reject" && !inputNote.trim())
    return void run(async () => {
      throw Error("拒绝申请时，请填写用户可见的处理说明");
    });
  confirming.value = true;
  try {
    const confirmed = await Promise.race([
      ElMessageBox.confirm(
        `确认${labels[type]}（售后 ${sale.id}，订单 ${sale.orderId}）？${type === "refund" ? "将登记退款流水；已发货退货需经仓储质检后良品入库。" : ""}`,
        `${labels[type]}确认`,
        { type: "warning" },
      ).then(() => true),
      new Promise<boolean>((resolve) => {
        cancelConfirmation = () => {
          ElMessageBox.close();
          resolve(false);
        };
      }),
    ]);
    cancelConfirmation = undefined;
    if (!confirmed || !alive) return;
    if (selected.value?.id !== sale.id || selected.value.status !== sale.status)
      return void (await run(async () => {
        throw new Error("申请已切换或状态已变化，请重新核对后操作");
      }));
    const success = await run(() => {
      if (!permitted(type)) throw new Error("当前员工没有此操作权限");
      return api.processAfterSale(sale.id, type, inputNote);
    }, labels[type] + "成功");
    if (
      success &&
      alive &&
      selected.value?.id === sale.id &&
      shop.syncStatus.phase === "ready"
    )
      loadLatestNote();
  } catch {
    /* dismissed */
  } finally {
    cancelConfirmation = undefined;
    confirming.value = false;
  }
}
</script>
<template>
  <div class="admin-page-head">
    <div>
      <h1>售后管理</h1>
      <p>有进度、有说明，让售后处理更透明。</p>
    </div>
    <el-tag effect="plain">退款为模拟</el-tag>
  </div>
  <section class="admin-panel">
    <div class="admin-toolbar">
      <el-input
        v-model="query"
        maxlength="100"
        placeholder="售后编号 / 订单号"
        clearable
      />
      <el-select v-model="status" clearable placeholder="全部售后状态"
        ><el-option
          v-for="(label, key) in afterSaleLabels"
          :key="key"
          :label="label"
          :value="key"
      /></el-select>
      <el-button
        @click="
          filters.update(
            { q: '', orderId: '', status: '' },
            { resetPage: true },
          )
        "
        >重置筛选</el-button
      >
      <span class="admin-note">{{ total }} 笔申请</span>
    </div>
    <p v-if="orderId" class="admin-note">
      指定订单 {{ orderId }}
      <el-button
        link
        @click="filters.update({ orderId: '' }, { resetPage: true })"
        >查看全部订单申请</el-button
      >
    </p>
    <el-table :data="rows" empty-text="暂无售后申请"
      ><el-table-column
        prop="id"
        label="售后编号"
        min-width="160"
      /><el-table-column label="关联订单" min-width="160"
        ><template #default="{ row }"
          ><RouterLink
            :to="{ path: '/admin/orders', query: { detail: row.orderId } }"
            >{{ row.orderId }}</RouterLink
          ></template
        ></el-table-column
      ><el-table-column
        prop="reason"
        label="申请原因"
        min-width="160"
      /><el-table-column label="类型" width="120"
        ><template #default="{ row }">{{
          row.requiresReturn ? "退货退款" : "仅退款"
        }}</template></el-table-column
      ><el-table-column label="本次退款" min-width="110"
        ><template #default="{ row }">{{
          money(row.refundAmount)
        }}</template></el-table-column
      ><el-table-column label="状态" width="110"
        ><template #default="{ row }"
          ><el-tag effect="plain">{{
            afterSaleLabels[row.status as keyof typeof afterSaleLabels]
          }}</el-tag></template
        ></el-table-column
      ><el-table-column label="申请时间" min-width="170"
        ><template #default="{ row }">{{
          dateTime(row.createdAt)
        }}</template></el-table-column
      ><el-table-column label="操作" width="100" fixed="right"
        ><template #default="{ row }"
          ><el-button
            type="primary"
            link
            :disabled="pending || confirming"
            @click="open(row)"
            >查看处理</el-button
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
    v-model="dialog"
    title="售后处理"
    width="660px"
    :close-on-click-modal="!pending && !confirming"
    :close-on-press-escape="!pending && !confirming"
    :show-close="!pending && !confirming"
    ><template v-if="selected"
      ><dl class="admin-detail-list">
        <dt>售后编号</dt>
        <dd>{{ selected.id }}</dd>
        <dt>关联订单</dt>
        <dd>
          {{ selected.orderId }}
          <RouterLink
            :to="{ path: '/admin/orders', query: { detail: selected.orderId } }"
            >查看关联订单</RouterLink
          >
        </dd>
        <dt>售后类型</dt>
        <dd>
          {{
            selected.requiresReturn
              ? "退货退款 · 收到退货后才能退款"
              : "未发货，仅退款"
          }}
        </dd>
        <dt>退款金额</dt>
        <dd>
          {{ money(selected.refundAmount) }}
        </dd>
        <dt>申请商品</dt>
        <dd>
          <div v-for="line in selected.lines" :key="line.orderItemId">
            {{
              selectedOrder?.items.find((i) => i.id === line.orderItemId)
                ?.name ?? "历史商品"
            }}
            × {{ line.quantity }} · {{ money(line.amount) }}
          </div>
        </dd>
        <dt>退货物流</dt>
        <dd>
          {{ selected.returnCarrier || "尚未填写" }}
          {{ selected.returnTracking }}
        </dd>
        <dt>申请原因</dt>
        <dd>{{ selected.reason }}</dd>
        <dt>用户说明</dt>
        <dd>{{ selected.description || "无补充说明" }}</dd>
        <dt>处理状态</dt>
        <dd>{{ afterSaleLabels[selected.status] }}</dd>
        <dt>当前处理说明</dt>
        <dd>{{ selected.note || "尚无处理说明" }}</dd>
      </dl>
      <el-alert
        v-if="noteConflict"
        title="处理说明已被其他页面更新，当前草稿已保留"
        type="warning"
        :closable="false"
      >
        <el-button
          link
          :disabled="pending || confirming"
          @click="loadLatestNote"
          >加载最新处理说明</el-button
        >
      </el-alert>
      <el-form label-position="top"
        ><el-form-item label="本次处理说明（用户可见）"
          ><el-input
            v-model="note"
            type="textarea"
            :rows="3"
            :disabled="
              busy ||
              confirming ||
              ['refunded', 'rejected', 'cancelled'].includes(selected.status)
            "
            placeholder="填写审核或收货情况；拒绝时必填" /></el-form-item></el-form
      ><el-alert :title="state?.guidance" type="info" :closable="false" />
      <p v-if="assignment" class="admin-note">{{ assignment }}</p>
      <ul class="admin-commerce-events" aria-label="售后进度">
        <li v-for="(event, index) in selected.events" :key="index">
          <time
            >{{ dateTime(event.at) }} ·
            {{
              event.actor === "admin"
                ? "管理员"
                : event.actor === "user"
                  ? "用户"
                  : "系统"
            }}</time
          >{{ eventLabel(event.action)
          }}<span v-if="event.note"> · {{ event.note }}</span>
        </li>
      </ul></template
    ><el-alert
      v-else
      title="没有找到该售后申请"
      type="warning"
      :closable="false"
    />
    <template #footer
      ><el-button :disabled="pending || confirming" @click="dialog = false"
        >关闭</el-button
      ><template v-if="allowedActions.approve"
        ><el-button
          type="danger"
          :loading="pending"
          :disabled="busy || confirming"
          @click="action('reject')"
          >拒绝</el-button
        ><el-button
          type="primary"
          :loading="pending"
          :disabled="busy || confirming"
          @click="action('approve')"
          >批准申请</el-button
        ></template
      ><el-button
        v-if="allowedActions.receive"
        type="primary"
        :loading="pending"
        :disabled="busy || confirming"
        @click="action('receive')"
        >确认收到退货</el-button
      ><el-button
        v-if="allowedActions.refund"
        type="primary"
        :loading="pending"
        :disabled="busy || confirming"
        @click="action('refund')"
        >执行模拟退款</el-button
      ></template
    ></el-dialog
  >
</template>
