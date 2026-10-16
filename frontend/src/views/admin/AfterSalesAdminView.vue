<script setup lang="ts">
import { computed, ref } from "vue";
import { ElMessageBox } from "element-plus";
import { useShop } from "../../stores/shop";
import { api } from "../../services/api";
import { afterSaleLabels, money, dateTime } from "../../domain/types";
import type { AfterSale } from "../../domain/types";
import { useAdminAction } from "./useAdmin";
const shop = useShop(),
  { busy, run } = useAdminAction(),
  status = ref(""),
  selectedId = ref(""),
  dialog = ref(false),
  note = ref("");
const rows = computed(() =>
  [...shop.db.afterSales]
    .filter((a) => !status.value || a.status === status.value)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
);
const selected = computed(() =>
  shop.db.afterSales.find((a) => a.id === selectedId.value),
);
function open(a: AfterSale) {
  selectedId.value = a.id;
  note.value = a.note;
  dialog.value = true;
}
async function action(type: "approve" | "reject" | "receive" | "refund") {
  if (!selected.value) return;
  const labels = {
    approve: "批准申请",
    reject: "拒绝申请",
    receive: "确认收到退货",
    refund: "执行模拟退款",
  };
  if (type === "reject" && !note.value.trim())
    return void run(async () => {
      throw Error("拒绝申请时，请填写用户可见的处理说明");
    });
  try {
    await ElMessageBox.confirm(
      `确认${labels[type]}？${type === "refund" ? "将生成退款流水并回补库存。" : ""}`,
      "售后处理",
      { type: "warning" },
    );
    await run(
      () => api.processAfterSale(selected.value!.id, type, note.value),
      labels[type] + "成功",
    );
  } catch {
    /* dismissed */
  }
}
</script>
<template>
  <div class="admin-page-head">
    <div>
      <h1>售后管理</h1>
      <p>有进度、有说明，让售后处理更透明。</p>
    </div>
    <el-tag effect="plain">退款为前端模拟</el-tag>
  </div>
  <section class="admin-panel">
    <div class="admin-toolbar">
      <el-select v-model="status" clearable placeholder="全部售后状态"
        ><el-option
          v-for="(label, key) in afterSaleLabels"
          :key="key"
          :label="label"
          :value="key"
      /></el-select>
    </div>
    <el-table :data="rows" empty-text="暂无售后申请"
      ><el-table-column
        prop="id"
        label="售后编号"
        min-width="160"
      /><el-table-column
        prop="orderId"
        label="关联订单"
        min-width="160"
      /><el-table-column
        prop="reason"
        label="申请原因"
        min-width="160"
      /><el-table-column label="类型" width="120"
        ><template #default="{ row }">{{
          row.requiresReturn ? "退货退款" : "仅退款"
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
          ><el-button type="primary" link @click="open(row)"
            >查看处理</el-button
          ></template
        ></el-table-column
      ></el-table
    >
  </section>
  <el-dialog v-model="dialog" title="售后处理" width="660px"
    ><template v-if="selected"
      ><dl class="admin-detail-list">
        <dt>关联订单</dt>
        <dd>{{ selected.orderId }}</dd>
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
          {{
            money(
              shop.db.orders.find((o) => o.id === selected?.orderId)?.total ||
                0,
            )
          }}
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
      <el-form label-position="top"
        ><el-form-item label="本次处理说明（用户可见）"
          ><el-input
            v-model="note"
            type="textarea"
            :rows="3"
            :disabled="['refunded', 'rejected'].includes(selected.status)"
            placeholder="填写审核或收货情况；拒绝时必填" /></el-form-item></el-form
      ><el-alert
        v-if="selected.status === 'approved' && selected.requiresReturn"
        title="等待用户退货。收到退货后确认收货，再执行模拟退款。"
        type="info"
        :closable="false" /></template
    ><template #footer
      ><el-button @click="dialog = false">关闭</el-button
      ><template v-if="selected?.status === 'requested'"
        ><el-button type="danger" :loading="busy" @click="action('reject')"
          >拒绝</el-button
        ><el-button type="primary" :loading="busy" @click="action('approve')"
          >批准申请</el-button
        ></template
      ><el-button
        v-if="selected?.status === 'approved' && selected.requiresReturn"
        type="primary"
        :loading="busy"
        @click="action('receive')"
        >确认收到退货</el-button
      ><el-button
        v-if="
          selected &&
          (selected.status === 'received' ||
            (selected.status === 'approved' && !selected.requiresReturn))
        "
        type="primary"
        :loading="busy"
        @click="action('refund')"
        >执行模拟退款</el-button
      ></template
    ></el-dialog
  >
</template>
