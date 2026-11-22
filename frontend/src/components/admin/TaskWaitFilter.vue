<script setup lang="ts">
const value = defineModel<string>({ required: true });
</script>

<template>
  <label>
    等待顺序
    <select v-model="value" aria-label="等待顺序">
      <option value="">默认排序</option>
      <option value="all">等待最久优先</option>
      <option value="soon">只看即将超时</option>
      <option value="overdue">只看超时</option>
    </select>
  </label>
</template>
