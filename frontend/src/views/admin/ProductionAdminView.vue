<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { useShop } from "../../stores/shop";
import { request } from "../../services/repository";
import {
  productionApi,
  type ChannelReconciliation,
  type Merchant,
  type ProductionPage,
  type ProductionStatus,
} from "../../services/production";
import type {
  Payment,
  PaymentProvider,
  Refund,
} from "../../../../shared/domain/production";
import { money, dateTime } from "../../domain/types";
import { ElMessageBox } from "element-plus";
const shop = useShop();
const availableTabs = [
  ["status", "接入状态", "settings"],
  ["merchant", "商家与协议", "settings"],
  ["payments", "渠道支付", "finance"],
  ["refunds", "渠道退款", "finance"],
  ["reconciliation", "渠道对账", "finance"],
  ["notifications", "通知投递", "settings"],
  ["shipments", "运单跟踪", "warehouse"],
] as const;
const tabs = computed(() =>
  availableTabs.filter((entry) =>
    shop.adminSession?.permissions?.includes(entry[2]),
  ),
);
const tab = ref<string>(""),
  loading = ref(false),
  error = ref(""),
  notice = ref(""),
  page = ref(1),
  total = ref(0);
const status = ref<ProductionStatus | null>(null),
  merchant = ref<Merchant | null>(null);
const payments = ref<Payment[]>([]),
  refunds = ref<Refund[]>([]),
  reconciliations = ref<ChannelReconciliation[]>([]);
interface Delivery {
  id: string;
  accountId: string;
  orderId: string | null;
  channel: string;
  event: string;
  status: string;
  attempts: number;
  lastError: string | null;
  retryVersion: number;
  createdAt: string;
  updatedAt: string;
}
interface Shipment {
  id: string;
  kind: "outbound" | "return";
  carrier: string;
  tracking: string;
  status: string;
  lastError: string | null;
  updatedAt: string;
  trace: {
    state?: string;
    status?: string;
    data: { time: string; context: string; status?: string }[];
  };
}
const notifications = ref<Delivery[]>([]),
  shipments = ref<Shipment[]>([]),
  shipmentEnabled = ref(false);
const form = reactive({
  provider: "alipay" as PaymentProvider,
  date: "",
  orderId: "",
  notificationStatus: "",
});
interface Difference {
  id: string;
  kind: string;
  merchantNo: string;
  code: string | null;
  expected: number | null;
  actual: number | null;
  fee: number;
}
const selectedReport = ref(""),
  differencePage = ref(1),
  differenceTotal = ref(0),
  differences = ref<Difference[]>([]);
const reviewNotes = reactive<Record<string, string>>({});
const requestIds = new Map<string, string>();
const labels: Record<string, string> = {
  creating: "创建中",
  pending: "等待处理",
  unknown: "待核对",
  succeeded: "成功",
  closed: "已关闭",
  failed: "失败",
  processing: "处理中",
  abnormal: "异常",
  done: "已完成",
  submitted: "已提交",
  sending: "发送中",
  subscribed: "已订阅",
  disabled: "未启用",
};
function label(value: string) {
  return labels[value] ?? value;
}
async function load() {
  if (!tab.value) return;
  loading.value = true;
  error.value = "";
  try {
    if (tab.value === "status") status.value = await productionApi.status();
    else if (tab.value === "merchant")
      merchant.value = await productionApi.merchant();
    else if (tab.value === "shipments") {
      if (form.orderId.trim()) {
        const result = await request<{ enabled: boolean; items: Shipment[] }>(
          `/api/orders/${encodeURIComponent(form.orderId.trim())}/shipment`,
        );
        shipments.value = result.items;
        shipmentEnabled.value = result.enabled;
      }
    } else if (tab.value === "notifications") {
      const result = await request<ProductionPage<Delivery>>(
        `/api/admin/notifications?page=${page.value}${form.notificationStatus ? `&status=${encodeURIComponent(form.notificationStatus)}` : ""}`,
      );
      notifications.value = result.items;
      total.value = result.total;
    } else {
      const result:
        | ProductionPage<Payment>
        | ProductionPage<Refund>
        | ProductionPage<ChannelReconciliation> =
        tab.value === "payments"
          ? await productionApi.payments(page.value)
          : tab.value === "refunds"
            ? await productionApi.refunds(page.value)
            : await productionApi.reconciliation(page.value);
      total.value = result.total;
      if (tab.value === "payments") payments.value = result.items as Payment[];
      else if (tab.value === "refunds")
        refunds.value = result.items as Refund[];
      else reconciliations.value = result.items as ChannelReconciliation[];
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "读取失败";
  } finally {
    loading.value = false;
  }
}
async function retryNotification(row: Delivery) {
  if (row.status === "unknown") {
    try {
      await ElMessageBox.confirm(
        "该通知可能已经送达。重试可能导致收件人再次收到同一条消息，是否继续？",
        "核对通知投递",
        {
          type: "warning",
          confirmButtonText: "确认可能重复，继续",
          cancelButtonText: "取消",
        },
      );
    } catch {
      return;
    }
  }
  await command(
    `/api/admin/notifications/${encodeURIComponent(row.id)}/retry`,
    {
      retryVersion: row.retryVersion,
      ...(row.status === "unknown" ? { confirmPossibleDuplicate: true } : {}),
    },
    "已提交原通知重试",
  );
}
async function loadDifferences(id: string, requestedPage = 1) {
  selectedReport.value = id;
  error.value = "";
  try {
    const result = await request<ProductionPage<Difference>>(
      `/api/admin/channel-reconciliation/${encodeURIComponent(id)}?page=${requestedPage}&pageSize=20`,
    );
    if (selectedReport.value !== id) return;
    differences.value = result.items;
    differencePage.value = result.page;
    differenceTotal.value = result.total;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "无法读取对账差异";
  }
}
async function command(
  path: string,
  args: Record<string, unknown>,
  success: string,
) {
  if (loading.value) return;
  loading.value = true;
  error.value = "";
  notice.value = "";
  const key = JSON.stringify([path, args]);
  const requestId = requestIds.get(key) ?? crypto.randomUUID();
  requestIds.set(key, requestId);
  try {
    await request(path, { ...args, requestId });
    requestIds.delete(key);
    notice.value = success;
    await load();
  } catch (cause) {
    error.value =
      cause instanceof Error
        ? cause.message
        : "操作结果未确认，请核对后使用原参数重试";
  } finally {
    loading.value = false;
  }
}
watch(
  tabs,
  (value) => {
    if (!value.some(([id]) => id === tab.value))
      tab.value = value[0]?.[0] ?? "";
  },
  { immediate: true },
);
watch(
  tab,
  () => {
    page.value = 1;
    notice.value = "";
    void load();
  },
  { immediate: true },
);
watch(page, () => {
  void load();
});
</script>
<template>
  <div class="admin-heading">
    <div>
      <p class="admin-eyebrow">PRODUCTION</p>
      <h1>生产接入</h1>
      <p>核对渠道结果、经营资料与配置状态。</p>
    </div>
    <el-button :loading="loading" @click="load">刷新</el-button>
  </div>
  <el-alert
    v-if="error"
    :title="error"
    type="error"
    :closable="false"
    show-icon
  />
  <el-alert
    v-if="notice"
    :title="notice"
    type="success"
    :closable="false"
    show-icon
  />
  <el-tabs v-model="tab"
    ><el-tab-pane
      v-for="entry in tabs"
      :key="entry[0]"
      :name="entry[0]"
      :label="entry[1]"
      :disabled="loading && tab !== entry[0]"
  /></el-tabs>
  <section
    v-if="tab === 'status' && status"
    class="admin-card production-panel"
  >
    <h2>当前接入状态</h2>
    <p>
      运行模式：{{ status.mode === "production" ? "生产模式" : "演示模式" }}
    </p>
    <p>已启用支付入口：{{ status.paymentChannels.join("、") || "无" }}</p>
    <dl>
      <template v-for="(value, key) in status.integrations" :key="key"
        ><dt>{{ key }}</dt>
        <dd>
          {{
            typeof value === "object" ? JSON.stringify(value) : String(value)
          }}
        </dd></template
      >
    </dl>
    <p>
      待核对支付 {{ status.counts.paymentsUnknown }} · 在途退款
      {{ status.counts.refundsPending }} · 失败回调
      {{ status.counts.webhooksFailed }} · 对账差异
      {{ status.counts.reconciliationDifferences }}
    </p>
    <el-alert
      title="这里显示配置与运行状态。真实商户、短信、物流和云存储联调需按接入文档单独验收。"
      type="info"
      :closable="false"
    />
  </section>
  <section
    v-else-if="tab === 'merchant' && merchant"
    class="admin-card production-panel"
  >
    <h2>商家资料与协议</h2>
    <el-form
      label-position="top"
      @submit.prevent="
        command('/api/admin/merchant', { merchant }, '商家资料已保存')
      "
    >
      <el-form-item label="经营主体" required
        ><el-input v-model="merchant.legalName" maxlength="120"
      /></el-form-item>
      <el-form-item label="客服邮箱"
        ><el-input v-model="merchant.serviceEmail" maxlength="254"
      /></el-form-item>
      <el-form-item label="客服电话"
        ><el-input v-model="merchant.servicePhone" maxlength="30"
      /></el-form-item>
      <el-form-item label="退货地址" required
        ><el-input
          v-model="merchant.returnAddress"
          type="textarea"
          :rows="3"
          maxlength="500"
      /></el-form-item>
      <h3>隐私政策</h3>
      <el-form-item label="版本" required
        ><el-input
          v-model="merchant.privacy.version"
          maxlength="80" /></el-form-item
      ><el-form-item label="标题" required
        ><el-input
          v-model="merchant.privacy.title"
          maxlength="120" /></el-form-item
      ><el-form-item label="正文" required
        ><el-input
          v-model="merchant.privacy.text"
          type="textarea"
          :rows="9"
          maxlength="30000"
      /></el-form-item>
      <h3>服务协议</h3>
      <el-form-item label="版本" required
        ><el-input
          v-model="merchant.terms.version"
          maxlength="80" /></el-form-item
      ><el-form-item label="标题" required
        ><el-input
          v-model="merchant.terms.title"
          maxlength="120" /></el-form-item
      ><el-form-item label="正文" required
        ><el-input
          v-model="merchant.terms.text"
          type="textarea"
          :rows="9"
          maxlength="30000"
      /></el-form-item>
      <p>正文变更时填写新版本；注册记录保存用户确认的协议版本。</p>
      <el-button type="primary" native-type="submit" :disabled="loading"
        >保存资料与协议</el-button
      >
    </el-form>
  </section>
  <section v-else-if="tab === 'payments'" class="admin-card production-panel">
    <el-table :data="payments" empty-text="暂无渠道支付单"
      ><el-table-column
        prop="id"
        label="支付单"
        min-width="210"
      /><el-table-column
        prop="orderId"
        label="订单"
        min-width="180"
      /><el-table-column
        prop="channel"
        label="入口"
        width="135"
      /><el-table-column label="金额" width="110"
        ><template #default="{ row }">{{
          money(row.amount)
        }}</template></el-table-column
      ><el-table-column label="状态" width="110"
        ><template #default="{ row }"
          >{{ label(row.status)
          }}<small v-if="row.closeRequested"> · 待关单</small></template
        ></el-table-column
      ><el-table-column
        prop="errorCode"
        label="错误码"
        min-width="160"
      /><el-table-column label="操作" width="140"
        ><template #default="{ row }"
          ><el-button
            :disabled="loading"
            @click="
              command(
                `/api/admin/payments/${encodeURIComponent(row.id)}/refresh`,
                {},
                '查询任务已提交，请刷新核对结果',
              )
            "
            >查询渠道</el-button
          ></template
        ></el-table-column
      ></el-table
    >
  </section>
  <section v-else-if="tab === 'refunds'" class="admin-card production-panel">
    <p>
      退款受理不等于退款成功；异常退款先在渠道处理，再查询同步。请勿在渠道与本系统同时重复发起退款。
    </p>
    <el-table :data="refunds" empty-text="暂无渠道退款单"
      ><el-table-column
        prop="id"
        label="退款单"
        min-width="210"
      /><el-table-column
        prop="afterSaleId"
        label="售后"
        min-width="180"
      /><el-table-column label="金额" width="110"
        ><template #default="{ row }"
          >{{ money(row.amount)
          }}<small v-if="row.noTransfer" class="zero-refund-note"
            >零金额售后，无资金流转</small
          ></template
        ></el-table-column
      ><el-table-column label="状态" width="110"
        ><template #default="{ row }">{{
          label(row.status)
        }}</template></el-table-column
      ><el-table-column
        prop="errorCode"
        label="错误码"
        min-width="160"
      /><el-table-column label="操作" width="225"
        ><template #default="{ row }"
          ><el-button
            :disabled="loading"
            @click="
              command(
                `/api/admin/refunds/${encodeURIComponent(row.id)}/refresh`,
                {},
                '查询任务已提交',
              )
            "
            >查询</el-button
          ><el-button
            v-if="
              ['unknown', 'processing'].includes(row.status) && !row.noTransfer
            "
            :disabled="loading"
            @click="
              command(
                `/api/admin/refunds/${encodeURIComponent(row.id)}/retry`,
                {},
                '已按原退款单重试',
              )
            "
            >按原单重试</el-button
          ><RouterLink
            v-if="row.status === 'failed'"
            :to="{
              path: '/admin/after-sales',
              query: { orderId: row.orderId, detail: row.afterSaleId },
            }"
            >返回售后重新发起</RouterLink
          >
          <p v-if="row.status === 'abnormal'">
            请在渠道平台处理后查询。
          </p></template
        ></el-table-column
      ></el-table
    >
  </section>
  <section
    v-else-if="tab === 'reconciliation'"
    class="admin-card production-panel"
  >
    <el-form
      inline
      @submit.prevent="
        command(
          '/api/admin/channel-reconciliation',
          { provider: form.provider, date: form.date },
          '对账任务已提交',
        )
      "
      ><el-form-item label="渠道"
        ><el-select v-model="form.provider" style="width: 140px"
          ><el-option value="alipay" label="支付宝" /><el-option
            value="wechatpay"
            label="微信支付" /></el-select></el-form-item
      ><el-form-item label="账单日期"
        ><input
          v-model="form.date"
          type="date"
          required
          aria-label="账单日期" /></el-form-item
      ><el-form-item
        ><el-button
          type="primary"
          native-type="submit"
          :disabled="loading || !form.date"
          >拉取并核对</el-button
        ></el-form-item
      ></el-form
    >
    <el-table :data="reconciliations" empty-text="暂无渠道对账记录"
      ><el-table-column prop="date" label="日期" width="120" /><el-table-column
        prop="provider"
        label="渠道"
        width="120"
      /><el-table-column label="状态" width="100"
        ><template #default="{ row }">{{
          label(row.status)
        }}</template></el-table-column
      ><el-table-column
        prop="differences"
        label="差异数"
        width="100"
      /><el-table-column label="创建时间" min-width="170"
        ><template #default="{ row }">{{
          dateTime(row.createdAt)
        }}</template></el-table-column
      ><el-table-column
        prop="errorCode"
        label="错误码"
        min-width="150"
      /><el-table-column label="复核" width="100"
        ><template #default="{ row }">{{
          row.reviewed ? "已复核" : "未复核"
        }}</template></el-table-column
      ><el-table-column label="操作" min-width="280"
        ><template #default="{ row }"
          ><el-button
            v-if="row.status === 'done'"
            :disabled="loading"
            @click="loadDifferences(row.id)"
            >查看明细</el-button
          ><el-button
            v-if="['failed', 'done'].includes(row.status)"
            :disabled="loading"
            @click="
              command(
                `/api/admin/channel-reconciliation/${encodeURIComponent(row.id)}/retry`,
                {},
                '重新对账任务已提交',
              )
            "
            >重新对账</el-button
          ><el-input
            v-if="!row.reviewed && row.status === 'done'"
            v-model="reviewNotes[row.id]"
            maxlength="500"
            placeholder="记录差异原因及处理依据"
            :aria-label="`复核说明 ${row.id}`"
          /><el-button
            v-if="!row.reviewed && row.status === 'done'"
            :disabled="loading || !reviewNotes[row.id]?.trim()"
            @click="
              command(
                `/api/admin/channel-reconciliation/${encodeURIComponent(row.id)}/review`,
                { note: reviewNotes[row.id] },
                '已记录人工复核',
              )
            "
            >记录复核</el-button
          ></template
        ></el-table-column
      ></el-table
    >
    <template v-if="selectedReport"
      ><h3>账单明细 {{ selectedReport }}</h3>
      <el-table :data="differences" empty-text="没有匹配的账单条目"
        ><el-table-column
          prop="kind"
          label="类型"
          width="100"
        /><el-table-column
          prop="merchantNo"
          label="商户单号"
          min-width="210"
        /><el-table-column
          prop="code"
          label="差异码"
          min-width="180"
        /><el-table-column label="本地金额" width="120"
          ><template #default="{ row }">{{
            row.expected === null ? "—" : money(row.expected)
          }}</template></el-table-column
        ><el-table-column label="渠道金额" width="120"
          ><template #default="{ row }">{{
            row.actual === null ? "—" : money(row.actual)
          }}</template></el-table-column
        ><el-table-column label="渠道手续费" width="120"
          ><template #default="{ row }">{{
            money(row.fee)
          }}</template></el-table-column
        ></el-table
      ><el-pagination
        :current-page="differencePage"
        :page-size="20"
        :total="differenceTotal"
        layout="prev, pager, next, total"
        @current-change="
          (value: number) => loadDifferences(selectedReport, value)
        "
    /></template>
  </section>
  <section
    v-else-if="tab === 'notifications'"
    class="admin-card production-panel"
  >
    <el-select
      v-model="form.notificationStatus"
      style="width: 180px"
      aria-label="投递状态"
      @change="
        page = 1;
        load();
      "
      ><el-option value="" label="全部状态" /><el-option
        value="pending"
        label="等待处理" /><el-option value="failed" label="失败" /><el-option
        value="unknown"
        label="送达未知" /><el-option value="submitted" label="已提交"
    /></el-select>
    <el-table :data="notifications" empty-text="暂无通知投递记录"
      ><el-table-column
        prop="id"
        label="投递记录"
        min-width="210"
      /><el-table-column
        prop="channel"
        label="渠道"
        width="100"
      /><el-table-column
        prop="event"
        label="事件"
        min-width="150"
      /><el-table-column label="状态" width="120"
        ><template #default="{ row }">{{
          label(row.status)
        }}</template></el-table-column
      ><el-table-column
        prop="attempts"
        label="尝试次数"
        width="100"
      /><el-table-column
        prop="lastError"
        label="错误码"
        min-width="160"
      /><el-table-column label="操作" width="160"
        ><template #default="{ row }"
          ><el-button
            v-if="['failed', 'unknown'].includes(row.status)"
            :disabled="loading"
            @click="retryNotification(row)"
            >核对后重试</el-button
          ></template
        ></el-table-column
      ></el-table
    >
  </section>
  <section v-else-if="tab === 'shipments'" class="admin-card production-panel">
    <el-form inline @submit.prevent="load"
      ><el-form-item label="订单编号"
        ><el-input
          v-model.trim="form.orderId"
          maxlength="100"
          placeholder="查询出库与退货运单" /></el-form-item
      ><el-form-item
        ><el-button native-type="submit" :disabled="loading || !form.orderId"
          >读取运单</el-button
        ></el-form-item
      ></el-form
    >
    <p v-if="form.orderId && !shipmentEnabled">
      物流接入尚未启用；已有发货记录仍保留。
    </p>
    <article
      v-for="shipment in shipments"
      :key="shipment.id"
      class="production-shipment"
    >
      <h3>
        {{ shipment.kind === "return" ? "退货运单" : "出库运单" }} ·
        {{ shipment.carrier }} {{ shipment.tracking }}
      </h3>
      <p>
        {{ label(shipment.status) }} {{ shipment.lastError }} ·
        {{ dateTime(shipment.updatedAt) }}
      </p>
      <el-button
        :disabled="loading || !shipmentEnabled"
        @click="
          command(
            `/api/orders/${encodeURIComponent(form.orderId)}/shipment/${encodeURIComponent(shipment.id)}/refresh`,
            {},
            '轨迹已查询',
          )
        "
        >查询最新轨迹</el-button
      >
      <el-button
        v-if="shipment.status === 'failed'"
        :disabled="loading || !shipmentEnabled"
        @click="
          command(
            `/api/admin/shipments/${encodeURIComponent(shipment.id)}/retry`,
            {},
            '订阅任务已重新提交',
          )
        "
        >重试订阅</el-button
      >
      <ol>
        <li v-for="(entry, index) in shipment.trace?.data ?? []" :key="index">
          {{ entry.time }} · {{ entry.context }}
        </li>
      </ol>
    </article>
  </section>
  <el-pagination
    v-if="
      ['payments', 'refunds', 'reconciliation', 'notifications'].includes(tab)
    "
    v-model:current-page="page"
    :page-size="20"
    :total="total"
    layout="prev, pager, next, total"
    :disabled="loading"
  />
</template>
<style scoped>
.production-panel {
  padding: 24px;
  margin-block: 16px;
  overflow: auto;
}
.production-panel .el-form {
  max-width: 850px;
}
.production-panel dl {
  display: grid;
  grid-template-columns: 140px 1fr;
  gap: 10px;
}
.production-panel dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.production-shipment {
  padding-block: 20px;
  border-bottom: 1px solid #e5e5df;
}
</style>
