<script setup lang="ts">
defineProps<{ error?: string; notice?: string }>()
</script>
<template>
  <p v-if="error" class="action-error" role="alert">{{ error }}</p>
  <p v-if="notice" class="action-notice" role="status">{{ notice }}</p>
</template>
