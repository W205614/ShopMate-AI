<script setup lang="ts">
import type { PurchaseOrder } from "../../../../shared/domain/operations";
import { dateTime, money } from "../../domain/types";

defineProps<{ orders: PurchaseOrder[]; busy: boolean }>();
const emit = defineEmits<{
  order: [order: PurchaseOrder];
  receive: [order: PurchaseOrder];
  cancel: [order: PurchaseOrder];
}>();
const statusLabels: Record<PurchaseOrder["status"], string> = {
  draft: "草稿",
  ordered: "已下单",
  partial: "部分入库",
  received: "已入库",
  cancelled: "已取消",
};
</script>

<template>
  <el-table :data="orders" row-key="id">
    <el-table-column type="expand">
      <template #default="{ row }">
        <p v-for="line in row.lines" :key="line.skuId">
          {{ line.productId }} / {{ line.skuId }} · 采购
          {{ line.quantity }}，已收 {{ line.received }}，单价
          {{ money(line.unitCost) }}
        </p>
        <p v-for="receipt in row.receipts" :key="receipt.id">
          入库 {{ receipt.id }} · {{ dateTime(receipt.createdAt) }} ·
          {{ money(receipt.amount) }}
        </p>
      </template>
    </el-table-column>
    <el-table-column prop="id" label="采购单" />
    <el-table-column prop="supplierId" label="供应商" />
    <el-table-column label="状态">
      <template #default="{ row }">{{
        statusLabels[row.status as PurchaseOrder["status"]] ?? "未知状态"
      }}</template>
    </el-table-column>
    <el-table-column label="操作" min-width="230">
      <template #default="{ row }">
        <el-button
          v-if="row.status === 'draft'"
          :disabled="busy"
          @click="emit('order', row)"
          >下单</el-button
        >
        <el-button
          v-if="['ordered', 'partial'].includes(row.status)"
          :disabled="busy"
          @click="emit('receive', row)"
          >分批入库</el-button
        >
        <el-button
          v-if="['draft', 'ordered'].includes(row.status)"
          :disabled="busy"
          @click="emit('cancel', row)"
          >取消</el-button
        >
      </template>
    </el-table-column>
  </el-table>
</template>
