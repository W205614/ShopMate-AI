<script setup lang="ts">
import type { Staff } from "../../../../shared/domain/operations";

defineProps<{
  staff: Staff[];
  busy: boolean;
  roleLabels: Record<string, string>;
}>();
const emit = defineEmits<{ edit: [staff: Staff] }>();
</script>

<template>
  <el-table :data="staff">
    <el-table-column prop="username" label="账号" />
    <el-table-column prop="name" label="姓名" />
    <el-table-column label="职责">
      <template #default="{ row }">
        {{ roleLabels[row.staffRole] ?? "未知职责" }}
      </template>
    </el-table-column>
    <el-table-column label="状态">
      <template #default="{ row }">{{ row.active ? "启用" : "停用" }}</template>
    </el-table-column>
    <el-table-column label="操作">
      <template #default="{ row }">
        <el-button :disabled="busy" @click="emit('edit', row)">编辑</el-button>
      </template>
    </el-table-column>
  </el-table>
</template>
