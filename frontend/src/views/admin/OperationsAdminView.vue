<script setup lang="ts">
import { computed, reactive, ref, watch, onUnmounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessageBox } from "element-plus";
import { useShop } from "../../stores/shop";
import { commerceAction, getCollectionPage } from "../../services/api";
import { request } from "../../services/repository";
import { dateTime, money } from "../../domain/types";
import type {
  Promotion,
  PurchaseOrder,
  ReturnInspection,
  ShippingRule,
  Staff,
  Supplier,
} from "../../../../shared/domain/operations";
import { useAdminAction } from "./useAdmin";
import RuntimeMaintenancePanel from "./RuntimeMaintenancePanel.vue";
import StaffManagementPanel from "./StaffManagementPanel.vue";
import PurchaseOrdersPanel from "./PurchaseOrdersPanel.vue";
const shop = useShop(),
  route = useRoute(),
  router = useRouter(),
  { busy, pending, run } = useAdminAction();
const availableTabs = [
  ["shippingRules", "配送运费", "settings"],
  ["promotions", "满减活动", "marketing"],
  ["suppliers", "供应商", "warehouse"],
  ["purchaseOrders", "采购入库", "warehouse"],
  ["returnInspections", "退货质检", "warehouse"],
  ["staff", "员工权限", "staff"],
  ["auditEntries", "操作审计", "audit"],
  ["reconciliation", "财务核对", "finance"],
  ["jobs", "后台任务", "settings"],
  ["runtime", "运行状态", "settings"],
] as const;
const tabs = computed(() =>
  availableTabs.filter((entry) =>
    shop.adminSession?.permissions?.includes(entry[2]),
  ),
);
const staffRoleLabels: Record<string, string> = {
  owner: "店主",
  operations: "运营",
  warehouse: "仓储",
  support: "客服",
  finance: "财务",
};
const auditDateTime = (value: string) =>
  new Date(value).toLocaleString("zh-CN", {
    hour12: false,
    timeZone: "Asia/Shanghai",
  });
const tab = computed(() => String(route.query.tab ?? tabs.value[0]?.[0] ?? ""));
const allowed = computed(() =>
  tabs.value.some((entry) => entry[0] === tab.value),
);
const metadata = computed(() => {
  void shop.db.revision;
  return getCollectionPage(tab.value);
});
const search = ref(String(route.query.q ?? "")),
  extraError = ref("");
watch([() => route.query.q, tab], ([value]) => {
  search.value = typeof value === "string" ? value : "";
});
const staff = ref<Staff[]>([]),
  reconciliation = ref<{
    balanced: boolean;
    revision: number;
    checkedAt: string;
    issues: {
      kind: string;
      reference: string;
      expected: string;
      actual: string;
    }[];
    totals: { income: string; refund: string; purchase: string; net: string };
  }>();
let viewEpoch = 0,
  extraSequence = 0,
  alive = true;
const captureView = () => ({
  epoch: viewEpoch,
  actorId: shop.adminSession?.id,
  tab: tab.value,
});
function isCurrent(scope: ReturnType<typeof captureView>) {
  return (
    alive &&
    scope.epoch === viewEpoch &&
    scope.actorId === shop.adminSession?.id &&
    scope.tab === tab.value &&
    allowed.value
  );
}
function assertCurrent(scope: ReturnType<typeof captureView>) {
  if (!isCurrent(scope))
    throw new Error("管理员身份或工作区已变化，请重新核对后操作");
}
async function runScoped(action: () => Promise<unknown>, message: string) {
  const scope = captureView();
  const success = await run(async () => {
    assertCurrent(scope);
    await action();
    assertCurrent(scope);
  }, message);
  return success && isCurrent(scope);
}
async function loadExtra() {
  const scope = captureView(),
    current = ++extraSequence;
  if (!allowed.value) return;
  extraError.value = "";
  try {
    if (scope.tab === "staff") {
      const response = await request<Staff[] | { items: Staff[] }>(
        "/api/admin/staff",
      );
      if (isCurrent(scope) && current === extraSequence)
        staff.value = Array.isArray(response) ? response : response.items;
    } else if (scope.tab === "reconciliation") {
      const response = await request<NonNullable<typeof reconciliation.value>>(
        "/api/admin/reconciliation",
      );
      if (isCurrent(scope) && current === extraSequence)
        reconciliation.value = response;
    }
  } catch (error) {
    if (isCurrent(scope) && current === extraSequence)
      extraError.value = error instanceof Error ? error.message : "读取失败";
  }
}
watch(
  [
    tab,
    () => shop.db.revision,
    () => shop.adminSession?.id,
    () => shop.adminSession?.permissions?.join(","),
  ],
  () => {
    void loadExtra();
  },
  { immediate: true },
);
watch(
  tabs,
  () => {
    if (!route.query.tab && tabs.value[0])
      void router.replace({ query: { ...route.query, tab: tabs.value[0][0] } });
  },
  { immediate: true },
);
function navigate(patch: Record<string, string | undefined>) {
  void router.push({ query: { ...route.query, page: undefined, ...patch } });
}
function changePage(page: number) {
  void router.push({
    query: { ...route.query, page: page > 1 ? String(page) : undefined },
  });
}
const defaults = () => ({
  id: "",
  version: 0,
  name: "",
  province: "*",
  enabled: true,
  fee: 0,
  freeAbove: 0,
  threshold: 0,
  discount: 0,
  startsAt: new Date().toISOString(),
  endsAt: new Date(Date.now() + 7 * 86400000).toISOString(),
  active: true,
  contact: "",
  username: "",
  password: "",
  staffRole: "operations",
  supplierId: "",
});
const form = reactive(defaults()),
  dialog = ref(false);
function edit(value?: ShippingRule | Promotion | Supplier | Staff) {
  Object.assign(form, defaults(), value ?? {});
  dialog.value = true;
}
async function save() {
  if (
    await runScoped(async () => {
      if (tab.value === "shippingRules")
        await commerceAction("saveShippingRule", {
          id: form.id || undefined,
          version: form.version,
          name: form.name,
          province: form.province,
          enabled: form.enabled,
          fee: form.fee,
          freeAbove: form.freeAbove,
        });
      else if (tab.value === "promotions")
        await commerceAction("savePromotion", {
          id: form.id || undefined,
          version: form.version,
          name: form.name,
          threshold: form.threshold,
          discount: form.discount,
          startsAt: form.startsAt,
          endsAt: form.endsAt,
          active: form.active,
        });
      else if (tab.value === "suppliers")
        await commerceAction("saveSupplier", {
          id: form.id || undefined,
          version: form.version,
          name: form.name,
          contact: form.contact,
          active: form.active,
        });
      else if (tab.value === "staff")
        await commerceAction("saveStaff", {
          id: form.id || undefined,
          username: form.username,
          name: form.name,
          password: form.password || undefined,
          staffRole: form.staffRole,
          active: form.active,
        });
      await loadExtra();
    }, "已保存")
  ) {
    dialog.value = false;
    form.password = "";
  }
}
const purchaseDialog = ref(false),
  supplierId = ref("");
const purchaseLines = ref([
  { productId: "", skuId: "", quantity: 1, unitCost: 0 },
]);
const supplierOptions = ref<Supplier[]>([]),
  productOptions = ref(shop.db.products);
let productSearch = 0,
  supplierSearch = 0;
async function searchProducts(search = "") {
  const current = ++productSearch,
    scope = captureView();
  const result = await request<{ items: typeof shop.db.products }>(
    `/api/collections/products?role=admin&pageSize=20&search=${encodeURIComponent(search)}`,
  );
  if (current !== productSearch || !isCurrent(scope)) return;
  const selected = new Set(purchaseLines.value.map((line) => line.productId));
  productOptions.value = [
    ...result.items,
    ...productOptions.value.filter(
      (product) =>
        selected.has(product.id) &&
        !result.items.some((item) => item.id === product.id),
    ),
  ];
}
async function searchSuppliers(search = "") {
  const current = ++supplierSearch,
    scope = captureView();
  const result = await request<{ items: Supplier[] }>(
    `/api/collections/suppliers?role=admin&pageSize=20&search=${encodeURIComponent(search)}`,
  );
  if (current === supplierSearch && isCurrent(scope))
    supplierOptions.value = [
      ...result.items,
      ...supplierOptions.value.filter(
        (supplier) =>
          supplier.id === supplierId.value &&
          !result.items.some((item) => item.id === supplier.id),
      ),
    ];
}
function lookupProducts(search: string) {
  void searchProducts(search).catch((error) => {
    extraError.value = error instanceof Error ? error.message : "商品搜索失败";
  });
}
function lookupSuppliers(search: string) {
  void searchSuppliers(search).catch((error) => {
    extraError.value =
      error instanceof Error ? error.message : "供应商搜索失败";
  });
}
async function openPurchase() {
  if (
    await runScoped(async () => {
      await Promise.all([searchProducts(), searchSuppliers()]);
    }, "已加载采购选项")
  ) {
    supplierId.value = "";
    purchaseLines.value = [
      { productId: "", skuId: "", quantity: 1, unitCost: 0 },
    ];
    purchaseDialog.value = true;
  }
}
async function createPurchase() {
  if (
    await runScoped(
      () =>
        commerceAction("createPurchaseOrder", {
          supplierId: supplierId.value,
          lines: purchaseLines.value,
        }),
      "采购草稿已创建",
    )
  )
    purchaseDialog.value = false;
}
const receiptOrder = ref<PurchaseOrder>(),
  receiptLines = ref<{ skuId: string; quantity: number; remaining: number }[]>(
    [],
  );
function openReceipt(order: PurchaseOrder) {
  receiptOrder.value = JSON.parse(JSON.stringify(order)) as PurchaseOrder;
  receiptLines.value = order.lines
    .filter((line) => line.quantity > line.received)
    .map((line) => ({
      skuId: line.skuId,
      quantity: 0,
      remaining: line.quantity - line.received,
    }));
}
function orderPurchase(order: PurchaseOrder) {
  return run(
    () => commerceAction("orderPurchase", order.id, order.version),
    "采购单已下单",
  );
}
function cancelPurchase(order: PurchaseOrder) {
  return run(
    () => commerceAction("cancelPurchase", order.id, order.version),
    "采购已取消",
  );
}
async function receive() {
  const order = receiptOrder.value;
  if (!order) return;
  if (
    await runScoped(
      () =>
        commerceAction("receivePurchase", {
          id: order.id,
          version: order.version,
          lines: receiptLines.value
            .filter((line) => line.quantity > 0)
            .map(({ skuId, quantity }) => ({ skuId, quantity })),
        }),
      "已入库并登记采购支出",
    )
  )
    receiptOrder.value = undefined;
}
const inspection = ref<ReturnInspection>(),
  quality = reactive({ good: 0, defective: 0, note: "" });
function openInspection(value: ReturnInspection) {
  inspection.value = JSON.parse(JSON.stringify(value)) as ReturnInspection;
  Object.assign(quality, { good: value.quantity, defective: 0, note: "" });
}
async function inspect() {
  if (!inspection.value) return;
  const value = inspection.value;
  if (
    await runScoped(
      () =>
        commerceAction("inspectReturn", {
          id: value.id,
          version: value.version,
          ...quality,
        }),
      "质检已登记，良品已入库",
    )
  )
    inspection.value = undefined;
}
async function dispose(value: ReturnInspection) {
  const scope = captureView();
  try {
    const result = await ElMessageBox.prompt(
      "请输入报废数量；操作将保留审计记录。",
      "次品处置",
      { inputPattern: /^[1-9]\d*$/, inputErrorMessage: "请输入正整数" },
    );
    assertCurrent(scope);
    const note = await ElMessageBox.prompt("请输入处置原因", "次品处置", {
      inputPattern: /\S+/,
      inputErrorMessage: "请填写原因",
    });
    assertCurrent(scope);
    await runScoped(
      () =>
        commerceAction("disposeReturn", {
          id: value.id,
          version: value.version,
          quantity: Number(result.value),
          note: note.value,
        }),
      "次品处置已登记",
    );
  } catch {
    /* dismissed */
  }
}
const createLabel = computed(
  () =>
    (
      ({
        shippingRules: "新增配送规则",
        promotions: "新增满减活动",
        suppliers: "新增供应商",
        staff: "新增员工",
      }) as Record<string, string>
    )[tab.value],
);
function clearPrivateState() {
  viewEpoch++;
  extraSequence++;
  productSearch++;
  supplierSearch++;
  ElMessageBox.close();
  dialog.value = false;
  purchaseDialog.value = false;
  receiptOrder.value = undefined;
  inspection.value = undefined;
  Object.assign(form, defaults());
  Object.assign(quality, { good: 0, defective: 0, note: "" });
  receiptLines.value = [];
  purchaseLines.value = [
    { productId: "", skuId: "", quantity: 1, unitCost: 0 },
  ];
  supplierId.value = "";
  supplierOptions.value = [];
  productOptions.value = [];
  staff.value = [];
  reconciliation.value = undefined;
  extraError.value = "";
}
watch(
  [
    () => shop.adminSession?.id,
    () => shop.adminSession?.permissions?.join(","),
    tab,
  ],
  clearPrivateState,
  { flush: "sync" },
);
onUnmounted(() => {
  alive = false;
  clearPrivateState();
});
</script>
<template>
  <div class="admin-page-head">
    <div>
      <h1>经营工作台</h1>
      <p>配送、促销、采购、质检及运行记录。金额输入单位为分。</p>
    </div>
    <el-button
      v-if="createLabel && allowed"
      type="primary"
      :disabled="busy"
      @click="edit()"
      >{{ createLabel }}</el-button
    ><el-button
      v-if="tab === 'purchaseOrders'"
      type="primary"
      :disabled="busy"
      @click="openPurchase"
      >新增采购单</el-button
    >
  </div>
  <section class="admin-panel">
    <div class="admin-toolbar">
      <el-button
        v-for="entry in tabs"
        :key="entry[0]"
        :type="tab === entry[0] ? 'primary' : 'default'"
        @click="navigate({ tab: entry[0], q: undefined })"
        >{{ entry[1] }}</el-button
      >
    </div>
    <el-alert
      v-if="!allowed"
      title="当前角色没有该工作区权限，请选择可用功能。"
      type="warning"
      :closable="false"
    />
    <template v-else>
      <el-alert
        v-if="extraError"
        :title="extraError"
        type="error"
        :closable="false"
      /><el-button v-if="extraError" @click="loadExtra">重新读取</el-button>
      <form
        v-if="!['staff', 'reconciliation', 'jobs', 'runtime'].includes(tab)"
        class="admin-toolbar"
        @submit.prevent="navigate({ q: search.trim() })"
      >
        <el-input
          v-model="search"
          maxlength="100"
          placeholder="搜索当前业务记录"
          clearable
          @clear="navigate({ q: undefined })"
        /><el-button native-type="submit">搜索</el-button
        ><span>共 {{ metadata?.total ?? 0 }} 条</span>
      </form>
      <el-table
        v-if="tab === 'shippingRules'"
        :data="shop.db.shippingRules ?? []"
        ><el-table-column prop="name" label="规则" /><el-table-column
          prop="province"
          label="配送省份（* 为默认）"
        /><el-table-column label="运费 / 包邮门槛"
          ><template #default="{ row }"
            >{{ money(row.fee) }} / {{ money(row.freeAbove) }}</template
          ></el-table-column
        ><el-table-column label="启用"
          ><template #default="{ row }">{{
            row.enabled ? "是" : "否"
          }}</template></el-table-column
        ><el-table-column label="操作"
          ><template #default="{ row }"
            ><el-button :disabled="busy" @click="edit(row)"
              >编辑</el-button
            ></template
          ></el-table-column
        ></el-table
      >
      <el-table v-if="tab === 'promotions'" :data="shop.db.promotions ?? []"
        ><el-table-column prop="name" label="活动" /><el-table-column
          label="满减"
          ><template #default="{ row }"
            >满 {{ money(row.threshold) }} 减
            {{ money(row.discount) }}</template
          ></el-table-column
        ><el-table-column label="有效期"
          ><template #default="{ row }"
            >{{ dateTime(row.startsAt) }} — {{ dateTime(row.endsAt) }}</template
          ></el-table-column
        ><el-table-column label="状态"
          ><template #default="{ row }">{{
            row.active ? "启用" : "停用"
          }}</template></el-table-column
        ><el-table-column label="操作"
          ><template #default="{ row }"
            ><el-button :disabled="busy" @click="edit(row)"
              >编辑</el-button
            ></template
          ></el-table-column
        ></el-table
      >
      <el-table v-if="tab === 'suppliers'" :data="shop.db.suppliers ?? []"
        ><el-table-column prop="name" label="供应商" /><el-table-column
          prop="contact"
          label="联系方式"
        /><el-table-column label="状态"
          ><template #default="{ row }">{{
            row.active ? "启用" : "停用"
          }}</template></el-table-column
        ><el-table-column label="操作"
          ><template #default="{ row }"
            ><el-button :disabled="busy" @click="edit(row)"
              >编辑</el-button
            ></template
          ></el-table-column
        ></el-table
      >
      <PurchaseOrdersPanel
        v-if="tab === 'purchaseOrders'"
        :orders="shop.db.purchaseOrders ?? []"
        :busy="busy"
        @order="orderPurchase"
        @receive="openReceipt"
        @cancel="cancelPurchase"
      />
      <el-table
        v-if="tab === 'returnInspections'"
        :data="shop.db.returnInspections ?? []"
        ><el-table-column prop="afterSaleId" label="售后单" /><el-table-column
          prop="skuId"
          label="规格"
        /><el-table-column label="数量"
          ><template #default="{ row }"
            >退货 {{ row.quantity }} / 良品 {{ row.good }} / 次品
            {{ row.defective }} / 已处置 {{ row.disposed }}</template
          ></el-table-column
        ><el-table-column label="操作"
          ><template #default="{ row }"
            ><el-button
              v-if="row.status === 'pending'"
              :disabled="busy"
              @click="openInspection(row)"
              >质检</el-button
            ><el-button
              v-if="row.defective > row.disposed"
              :disabled="busy"
              @click="dispose(row)"
              >次品处置</el-button
            ></template
          ></el-table-column
        ></el-table
      >
      <StaffManagementPanel
        v-if="tab === 'staff'"
        :staff="staff"
        :busy="busy"
        :role-labels="staffRoleLabels"
        @edit="edit"
      />
      <el-table v-if="tab === 'auditEntries'" :data="shop.db.auditEntries ?? []"
        ><el-table-column label="时间（北京时间）" min-width="180"
          ><template #default="{ row }">{{
            auditDateTime(row.createdAt)
          }}</template></el-table-column
        ><el-table-column prop="actorId" label="操作者" /><el-table-column
          prop="action"
          label="动作" /><el-table-column
          prop="objectId"
          label="对象" /><el-table-column
          prop="result"
          label="结果" /><el-table-column prop="requestId" label="请求标识"
      /></el-table>
      <template v-if="tab === 'reconciliation' && reconciliation"
        ><h2>
          {{ reconciliation.balanced ? "收支核对一致" : "存在核对差异" }}
        </h2>
        <p class="admin-note">
          核对时间
          {{
            dateTime(reconciliation.checkedAt)
          }}；结果对应当时的数据快照，后续交易请重新核对。
        </p>
        <p>
          收款 {{ money(BigInt(reconciliation.totals.income)) }} · 退款
          {{ money(BigInt(reconciliation.totals.refund)) }} · 采购
          {{ money(BigInt(reconciliation.totals.purchase)) }} · 净收支
          {{ money(BigInt(reconciliation.totals.net)) }}（不代表利润）
        </p>
        <el-table :data="reconciliation.issues"
          ><el-table-column prop="kind" label="差异类型" /><el-table-column
            prop="reference"
            label="关联记录" /><el-table-column
            prop="expected"
            label="应有值" /><el-table-column
            prop="actual"
            label="实际值" /></el-table
      ></template>
      <RuntimeMaintenancePanel
        v-if="tab === 'jobs' || tab === 'runtime'"
        :key="`${shop.adminSession?.id}:${tab}`"
        :mode="tab"
      />
      <el-pagination
        v-if="metadata && metadata.pages > 1"
        :current-page="metadata.page"
        :total="metadata.total"
        :page-size="metadata.pageSize"
        layout="prev, pager, next"
        @current-change="changePage"
      />
    </template>
  </section>
  <el-dialog v-model="dialog" :title="createLabel" :close-on-click-modal="false"
    ><p>编辑冲突时保留本地草稿。请关闭后重新编辑最新记录。</p>
    <el-form label-position="top" @submit.prevent="save"
      ><el-form-item label="名称" required
        ><el-input v-model="form.name" :disabled="busy" maxlength="80"
      /></el-form-item>
      <template v-if="tab === 'shippingRules'"
        ><el-form-item label="省份（* 为默认规则）"
          ><el-input v-model="form.province" :disabled="busy" /></el-form-item
        ><el-form-item label="运费（分）"
          ><el-input-number
            v-model="form.fee"
            :min="0"
            :precision="0"
            :disabled="busy" /></el-form-item
        ><el-form-item label="包邮门槛（分，0 表示不设置门槛）"
          ><el-input-number
            v-model="form.freeAbove"
            :min="0"
            :precision="0"
            :disabled="busy" /></el-form-item
        ><el-checkbox v-model="form.enabled" :disabled="busy"
          >启用配送</el-checkbox
        ></template
      >
      <template v-if="tab === 'promotions'"
        ><el-form-item label="满额门槛（分）"
          ><el-input-number
            v-model="form.threshold"
            :min="0"
            :precision="0"
            :disabled="busy" /></el-form-item
        ><el-form-item label="减免（分）"
          ><el-input-number
            v-model="form.discount"
            :min="1"
            :precision="0"
            :disabled="busy" /></el-form-item
        ><el-form-item label="开始"
          ><el-date-picker
            v-model="form.startsAt"
            type="datetime"
            value-format="YYYY-MM-DDTHH:mm:ssZ"
            :disabled="busy" /></el-form-item
        ><el-form-item label="结束"
          ><el-date-picker
            v-model="form.endsAt"
            type="datetime"
            value-format="YYYY-MM-DDTHH:mm:ssZ"
            :disabled="busy" /></el-form-item
      ></template>
      <el-form-item v-if="tab === 'suppliers'" label="联系方式"
        ><el-input v-model="form.contact" :disabled="busy"
      /></el-form-item>
      <template v-if="tab === 'staff'"
        ><el-form-item label="登录账号"
          ><el-input
            v-model="form.username"
            :disabled="busy || !!form.id" /></el-form-item
        ><el-form-item label="密码（编辑时留空保留）"
          ><el-input
            v-model="form.password"
            type="password"
            show-password
            autocomplete="new-password"
            :disabled="busy" /></el-form-item
        ><el-form-item label="职责"
          ><el-select v-model="form.staffRole" :disabled="busy"
            ><el-option
              v-for="role in [
                'owner',
                'operations',
                'warehouse',
                'support',
                'finance',
              ]"
              :key="role"
              :value="role"
              :label="staffRoleLabels[role]" /></el-select></el-form-item
      ></template>
      <el-checkbox
        v-if="tab !== 'shippingRules'"
        v-model="form.active"
        :disabled="busy"
        >启用</el-checkbox
      >
      <div>
        <el-button
          type="primary"
          native-type="submit"
          :loading="pending"
          :disabled="busy"
          >保存</el-button
        >
      </div></el-form
    ></el-dialog
  >
  <el-dialog
    v-model="purchaseDialog"
    title="采购草稿"
    :close-on-click-modal="false"
    ><el-form label-position="top" @submit.prevent="createPurchase"
      ><el-form-item label="供应商"
        ><el-select
          v-model="supplierId"
          filterable
          remote
          :remote-method="lookupSuppliers"
          placeholder="输入供应商名称搜索"
          ><el-option
            v-for="supplier in supplierOptions.filter((item) => item.active)"
            :key="supplier.id"
            :value="supplier.id"
            :label="supplier.name" /></el-select
      ></el-form-item>
      <div
        v-for="(line, index) in purchaseLines"
        :key="index"
        class="admin-toolbar"
      >
        <el-select
          v-model="line.productId"
          filterable
          remote
          :remote-method="lookupProducts"
          placeholder="商品"
          @change="line.skuId = ''"
          ><el-option
            v-for="product in productOptions"
            :key="product.id"
            :value="product.id"
            :label="product.name" /></el-select
        ><el-select v-model="line.skuId" placeholder="规格"
          ><el-option
            v-for="sku in productOptions.find(
              (item) => item.id === line.productId,
            )?.skus ?? []"
            :key="sku.id"
            :value="sku.id"
            :label="sku.name" /></el-select
        ><el-input-number
          v-model="line.quantity"
          :min="1"
          :precision="0"
          aria-label="采购数量"
        /><el-input-number
          v-model="line.unitCost"
          :min="0"
          :precision="0"
          aria-label="单件成本（分）"
        /><el-button
          :disabled="purchaseLines.length <= 1"
          @click="purchaseLines.splice(index, 1)"
          >移除</el-button
        >
      </div>
      <p>可输入名称搜索商品和供应商；单件成本单位为分。</p>
      <el-button
        @click="
          purchaseLines.push({
            productId: '',
            skuId: '',
            quantity: 1,
            unitCost: 0,
          })
        "
        >添加商品</el-button
      ><el-button
        type="primary"
        native-type="submit"
        :disabled="busy"
        :loading="pending"
        >创建草稿</el-button
      ></el-form
    ></el-dialog
  >
  <el-dialog
    :model-value="!!receiptOrder"
    title="分批入库"
    :close-on-click-modal="false"
    @close="receiptOrder = undefined"
    ><p>{{ receiptOrder?.id }}。仅提交本次实收数量，库存及支出同时登记。</p>
    <el-form @submit.prevent="receive"
      ><el-form-item
        v-for="line in receiptLines"
        :key="line.skuId"
        :label="`${line.skuId}（未收 ${line.remaining}）`"
        ><el-input-number
          v-model="line.quantity"
          :min="0"
          :max="line.remaining"
          :precision="0"
          :disabled="busy" /></el-form-item
      ><el-button
        type="primary"
        native-type="submit"
        :loading="pending"
        :disabled="busy"
        >确认本次入库</el-button
      ></el-form
    ></el-dialog
  >
  <el-dialog
    :model-value="!!inspection"
    title="退货质检"
    :close-on-click-modal="false"
    @close="inspection = undefined"
    ><p>
      本批退货 {{ inspection?.quantity }} 件。良品 + 次品必须等于退货数量。
    </p>
    <el-form @submit.prevent="inspect"
      ><el-form-item label="良品"
        ><el-input-number
          v-model="quality.good"
          :min="0"
          :max="inspection?.quantity ?? 0"
          :precision="0"
          :disabled="busy" /></el-form-item
      ><el-form-item label="次品"
        ><el-input-number
          v-model="quality.defective"
          :min="0"
          :max="inspection?.quantity ?? 0"
          :precision="0"
          :disabled="busy" /></el-form-item
      ><el-form-item label="质检说明"
        ><el-input v-model="quality.note" :disabled="busy" /></el-form-item
      ><el-button
        type="primary"
        native-type="submit"
        :loading="pending"
        :disabled="busy"
        >登记质检</el-button
      ></el-form
    ></el-dialog
  >
</template>
