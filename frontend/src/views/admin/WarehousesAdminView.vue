<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { api } from "../../services/api";
import { request } from "../../services/repository";
import { useShop } from "../../stores/shop";
import type { Staff } from "../../../../shared/domain/operations";
import { deliveryProvinces } from "../../../../shared/domain/delivery-province";
import type {
  StockTransfer,
  WarehouseAssignment,
  Warehouse,
  WarehouseStock,
} from "../../../../shared/domain/warehouses";
import { useAdminAction } from "./useAdmin";

type Stock = WarehouseStock & {
  product: string;
  sku: string;
  available: number;
  reserved: number;
};
type Transfer = StockTransfer & {
  lines: (StockTransfer["lines"][number] & { product: string; sku: string })[];
};
const shop = useShop();
const { busy, run } = useAdminAction();
const data = ref<{
  warehouses: Warehouse[];
  destinations: Pick<Warehouse, "id" | "name">[];
  stocks: Stock[];
  transfers: Transfer[];
  assignments: WarehouseAssignment[];
}>({
  warehouses: [],
  destinations: [],
  stocks: [],
  transfers: [],
  assignments: [],
});
const people = ref<Staff[]>([]);
const warehouseId = ref("");
const query = ref("");
const target = ref("");
const transferQuantities = reactive<Record<string, number>>({});
const editing = ref(false);
const form = reactive<Parameters<typeof api.saveWarehouse>[0]>({
  name: "",
  priority: 0,
  provinces: [],
  acceptsOrders: true,
  returnAddress: "",
});
const adjusting = ref<Stock>();
const count = ref(0);
const reason = ref("");
const receiving = ref<Transfer>();
const returning = ref(false);
const receipt = reactive<
  Record<string, { quantity: number; discrepancy: number }>
>({});
const note = ref("");
const employee = ref("");
const assignment = ref<string[]>([]);
const owner = computed(() => shop.adminSession?.staffRole === "owner");
const current = computed(() =>
  data.value.warehouses.find((warehouse) => warehouse.id === warehouseId.value),
);
const stocks = computed(() =>
  data.value.stocks.filter(
    (stock) =>
      stock.warehouseId === warehouseId.value &&
      `${stock.product} ${stock.sku}`.includes(query.value.trim()),
  ),
);
const label = (id: string) =>
  data.value.destinations.find((warehouse) => warehouse.id === id)?.name ?? id;
const transferStatus = {
  locked: "待出库",
  inTransit: "在途",
  received: "已结单",
  cancelled: "已撤销",
};
async function refresh() {
  data.value = await request("/api/admin/warehouses");
  if (!current.value) warehouseId.value = data.value.warehouses[0]?.id ?? "";
}
onMounted(() =>
  run(async () => {
    await refresh();
    if (owner.value)
      people.value = (
        await request<{ items: Staff[] }>("/api/admin/staff")
      ).items.filter((staff) => staff.staffRole === "warehouse");
  }),
);
function edit(warehouse?: Warehouse) {
  Object.assign(form, {
    id: warehouse?.id,
    version: warehouse?.version,
    name: warehouse?.name ?? "",
    priority: warehouse?.priority ?? 0,
    provinces: [...(warehouse?.provinces ?? [])],
    acceptsOrders: warehouse?.acceptsOrders ?? true,
    returnAddress: warehouse?.returnAddress ?? "",
  });
  editing.value = true;
}
async function save() {
  if (
    await run(async () => {
      const warehouse = await api.saveWarehouse({
        ...form,
        returnAddress: form.returnAddress?.trim() || undefined,
      });
      await refresh();
      warehouseId.value = warehouse.id;
    }, "仓库已保存")
  )
    editing.value = false;
}
async function assign() {
  await run(async () => {
    await api.assignWarehouses(employee.value, assignment.value);
    await refresh();
  }, "仓库授权已更新");
}
function selectEmployee() {
  assignment.value = [
    ...(data.value.assignments.find((entry) => entry.id === employee.value)
      ?.warehouseIds ?? ["warehouse-default"]),
  ];
}
function changeCount(stock: Stock) {
  adjusting.value = stock;
  count.value = stock.onHand;
  reason.value = "";
}
async function saveCount() {
  const stock = adjusting.value!;
  if (
    await run(async () => {
      await api.adjustStock(
        stock.productId,
        stock.skuId,
        count.value,
        0,
        reason.value,
        {
          requestId: crypto.randomUUID(),
          warehouseId: stock.warehouseId,
          mode: "count",
          expectedStock: stock.onHand,
        },
      );
      await refresh();
    }, "盘点已登记")
  )
    adjusting.value = undefined;
}
async function createTransfer() {
  await run(async () => {
    const lines = data.value.stocks
      .filter(
        (stock) =>
          stock.warehouseId === warehouseId.value &&
          transferQuantities[stock.id]! > 0,
      )
      .map((stock) => ({
        productId: stock.productId,
        skuId: stock.skuId,
        quantity: transferQuantities[stock.id]!,
      }));
    await api.createStockTransfer(warehouseId.value, target.value, lines);
    for (const id of Object.keys(transferQuantities))
      delete transferQuantities[id];
    await refresh();
  }, "调拨库存已锁定");
}
async function transferAction(
  transfer: Transfer,
  action: "dispatch" | "cancel",
) {
  await run(
    async () => {
      await (
        action === "dispatch"
          ? api.dispatchStockTransfer
          : api.cancelStockTransfer
      )(transfer.id, transfer.version);
      await refresh();
    },
    action === "dispatch" ? "已调拨出库" : "调拨已撤销",
  );
}
function receive(transfer: Transfer, toSource = false) {
  returning.value = toSource;
  for (const line of transfer.lines)
    receipt[line.skuId] = {
      quantity:
        line.quantity - line.received - line.discrepancy - line.returned,
      discrepancy: 0,
    };
  note.value = "";
  receiving.value = transfer;
}
async function saveReceipt() {
  const transfer = receiving.value!;
  if (
    await run(
      async () => {
        const lines = transfer.lines
          .map((line) => ({ skuId: line.skuId, ...receipt[line.skuId]! }))
          .filter((line) => line.quantity + line.discrepancy > 0);
        if (returning.value)
          await api.returnStockTransfer(
            transfer.id,
            transfer.version,
            lines.map(({ skuId, quantity }) => ({ skuId, quantity })),
            note.value.trim(),
          );
        else
          await api.receiveStockTransfer(
            transfer.id,
            transfer.version,
            lines,
            note.value.trim() || undefined,
          );
        await refresh();
      },
      returning.value ? "调拨退回已登记" : "调拨收货已登记",
    )
  )
    receiving.value = undefined;
}
</script>

<template>
  <div class="admin-page-head">
    <div>
      <h1>多仓履约</h1>
      <p>查看实物库存、待发商品和调拨进度。</p>
    </div>
    <el-button v-if="owner" type="primary" :disabled="busy" @click="edit()"
      >新增仓库</el-button
    >
  </div>
  <section class="admin-panel">
    <div class="admin-toolbar">
      <el-select
        v-model="warehouseId"
        aria-label="当前仓库"
        placeholder="选择仓库"
      >
        <el-option
          v-for="warehouse in data.warehouses"
          :key="warehouse.id"
          :value="warehouse.id"
          :label="warehouse.name"
        />
      </el-select>
      <el-input
        v-model="query"
        aria-label="筛选库存"
        placeholder="商品或规格"
        clearable
      />
      <el-button v-if="owner && current" :disabled="busy" @click="edit(current)"
        >编辑仓库</el-button
      >
    </div>
    <p v-if="current">
      {{ current.acceptsOrders ? "接收新订单" : "停止接收新订单" }} ·
      {{ current.provinces.join("、") || "全部配送区域" }}
    </p>
    <el-table :data="stocks" empty-text="该仓库暂无库存">
      <el-table-column prop="product" label="商品" min-width="140" />
      <el-table-column prop="sku" label="规格" min-width="110" />
      <el-table-column prop="onHand" label="在库" />
      <el-table-column prop="available" label="可用" />
      <el-table-column prop="reserved" label="待付款预占" />
      <el-table-column prop="committed" label="已付款待发" />
      <el-table-column prop="transferLocked" label="调拨锁定" />
      <el-table-column prop="defective" label="隔离次品" />
      <el-table-column label="调拨数量" width="135"
        ><template #default="{ row }">
          <el-input-number
            v-model="transferQuantities[row.id]"
            :min="0"
            :max="Math.max(0, row.available)"
            :controls="false"
            size="small"
            :aria-label="`调拨 ${row.sku}`"
          /> </template
      ></el-table-column>
      <el-table-column label="操作"
        ><template #default="{ row }">
          <el-button
            link
            type="primary"
            :disabled="busy"
            @click="changeCount(row)"
            >盘点</el-button
          >
        </template></el-table-column
      >
    </el-table>
    <div v-if="current" class="admin-toolbar">
      <el-select
        v-model="target"
        aria-label="调拨目的仓"
        placeholder="选择调拨目的仓"
      >
        <el-option
          v-for="warehouse in data.destinations.filter(
            (entry) => entry.id !== warehouseId,
          )"
          :key="warehouse.id"
          :value="warehouse.id"
          :label="warehouse.name"
        />
      </el-select>
      <el-button
        type="primary"
        :disabled="busy || !target || target === warehouseId"
        @click="createTransfer"
        >创建调拨</el-button
      >
    </div>
  </section>
  <section class="admin-panel">
    <h2>调拨记录</h2>
    <el-table :data="data.transfers" empty-text="暂无调拨记录">
      <el-table-column label="来源仓"
        ><template #default="{ row }">{{
          label(row.fromWarehouseId)
        }}</template></el-table-column
      >
      <el-table-column label="目的仓"
        ><template #default="{ row }">{{
          label(row.toWarehouseId)
        }}</template></el-table-column
      >
      <el-table-column label="商品"
        ><template #default="{ row }">
          <div v-for="line in row.lines" :key="line.skuId">
            {{ line.product }} · {{ line.sku }} · {{ line.quantity }} 件，实收
            {{ line.received }}，退回 {{ line.returned }}，差异
            {{ line.discrepancy }}
          </div>
          <small v-if="row.note">{{ row.note }}</small>
        </template></el-table-column
      >
      <el-table-column label="状态"
        ><template #default="{ row }">{{
          transferStatus[row.status as StockTransfer["status"]]
        }}</template></el-table-column
      >
      <el-table-column label="操作"
        ><template #default="{ row }">
          <template
            v-if="
              row.status === 'locked' &&
              data.warehouses.some(
                (warehouse) => warehouse.id === row.fromWarehouseId,
              )
            "
          >
            <el-button
              link
              type="primary"
              :disabled="busy"
              @click="transferAction(row, 'dispatch')"
              >出库</el-button
            >
            <el-button
              link
              :disabled="busy"
              @click="transferAction(row, 'cancel')"
              >撤销</el-button
            >
          </template>
          <el-button
            v-if="
              row.status === 'inTransit' &&
              data.warehouses.some(
                (warehouse) => warehouse.id === row.fromWarehouseId,
              )
            "
            link
            :disabled="busy"
            @click="receive(row, true)"
            >登记退回</el-button
          >
          <el-button
            v-if="
              row.status === 'inTransit' &&
              data.warehouses.some(
                (warehouse) => warehouse.id === row.toWarehouseId,
              )
            "
            link
            type="primary"
            :disabled="busy"
            @click="receive(row)"
            >收货</el-button
          >
        </template></el-table-column
      >
    </el-table>
  </section>
  <section v-if="owner" class="admin-panel">
    <h2>仓库员工权限</h2>
    <div class="admin-toolbar">
      <el-select
        v-model="employee"
        aria-label="仓库员工"
        placeholder="选择仓库员工"
        @change="selectEmployee"
      >
        <el-option
          v-for="person in people"
          :key="person.id"
          :value="person.id"
          :label="person.name"
        />
      </el-select>
      <el-select
        v-model="assignment"
        multiple
        aria-label="授权仓库"
        placeholder="选择授权仓库"
      >
        <el-option
          v-for="warehouse in data.warehouses"
          :key="warehouse.id"
          :value="warehouse.id"
          :label="warehouse.name"
        />
      </el-select>
      <el-button :disabled="busy || !employee" @click="assign"
        >保存授权</el-button
      >
    </div>
  </section>
  <el-dialog
    v-model="editing"
    title="仓库档案"
    width="520px"
    :close-on-click-modal="false"
  >
    <el-form label-position="top" :disabled="busy" @submit.prevent="save">
      <el-form-item label="仓库名称"
        ><el-input v-model="form.name" maxlength="60"
      /></el-form-item>
      <el-form-item label="分配优先级，数值越小越优先"
        ><el-input-number v-model="form.priority" :min="0" :precision="0"
      /></el-form-item>
      <el-form-item label="可配送省份，留空为全部"
        ><el-select v-model="form.provinces" multiple filterable>
          <el-option
            v-for="province in deliveryProvinces"
            :key="province"
            :label="province"
            :value="province"
          /> </el-select
      ></el-form-item>
      <el-form-item label="退货地址"
        ><el-input v-model="form.returnAddress" maxlength="300"
      /></el-form-item>
      <el-checkbox v-model="form.acceptsOrders">接收新订单</el-checkbox>
      <el-button native-type="submit" type="primary" :disabled="busy"
        >保存仓库</el-button
      >
    </el-form>
  </el-dialog>
  <el-dialog
    :model-value="!!adjusting"
    title="仓库盘点"
    width="420px"
    @close="adjusting = undefined"
  >
    <el-form label-position="top" :disabled="busy" @submit.prevent="saveCount">
      <el-form-item label="实盘数量"
        ><el-input-number v-model="count" :min="0" :precision="0"
      /></el-form-item>
      <el-form-item label="盘点原因"
        ><el-input v-model="reason" maxlength="200"
      /></el-form-item>
      <el-button native-type="submit" type="primary" :disabled="busy"
        >登记盘点</el-button
      >
    </el-form>
  </el-dialog>
  <el-dialog
    :model-value="!!receiving"
    :title="returning ? '调拨退回来源仓' : '调拨收货'"
    width="540px"
    @close="receiving = undefined"
  >
    <el-form
      label-position="top"
      :disabled="busy"
      @submit.prevent="saveReceipt"
    >
      <el-form-item
        v-for="line in receiving?.lines ?? []"
        :key="line.skuId"
        :label="`${line.product} · ${line.sku}（在途 ${line.quantity - line.received - line.discrepancy - line.returned} 件）`"
      >
        <label
          >{{ returning ? "退回数量" : "实收" }}
          <el-input-number
            v-model="receipt[line.skuId]!.quantity"
            :min="0"
            :precision="0"
        /></label>
        <label v-if="!returning"
          >确认少收
          <el-input-number
            v-model="receipt[line.skuId]!.discrepancy"
            :min="0"
            :precision="0"
        /></label>
      </el-form-item>
      <el-form-item :label="returning ? '退回原因' : '差异原因'"
        ><el-input v-model="note" maxlength="300"
      /></el-form-item>
      <el-button native-type="submit" type="primary" :disabled="busy">{{
        returning ? "登记退回" : "登记收货"
      }}</el-button>
    </el-form>
  </el-dialog>
</template>
