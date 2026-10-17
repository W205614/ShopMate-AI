<script setup lang="ts">
import { reactive } from "vue";
import type { Address, AddressInput } from "../../domain/types";
const props = defineProps<{
  address?: Address;
  first: boolean;
  busy: boolean;
}>();
const emit = defineEmits<{ save: [input: AddressInput]; cancel: [] }>();
const form = reactive<AddressInput>({
  id: props.address?.id,
  name: props.address?.name ?? "",
  phone: props.address?.phone ?? "",
  region: props.address?.region ?? "",
  detail: props.address?.detail ?? "",
  isDefault: props.address?.isDefault ?? props.first,
});
</script>
<template>
  <form
    class="address-form form-stack"
    @submit.prevent="emit('save', { ...form })"
  >
    <h3>{{ form.id ? "编辑地址" : "添加收货地址" }}</h3>
    <div class="form-two">
      <label
        >收货人<input
          v-model.trim="form.name"
          required
          maxlength="30"
          autocomplete="name"
      /></label>
      <label
        >联系电话<input
          v-model.trim="form.phone"
          required
          pattern="1[0-9]{10}"
          inputmode="tel"
          autocomplete="tel"
      /></label>
    </div>
    <label
      >省 / 市 / 区<input
        v-model.trim="form.region"
        required
        maxlength="80"
        autocomplete="address-level2"
    /></label>
    <label
      >详细地址<input
        v-model.trim="form.detail"
        required
        maxlength="150"
        autocomplete="street-address"
    /></label>
    <label class="check-label"
      ><input v-model="form.isDefault" type="checkbox" />设为默认收货地址</label
    >
    <div class="button-row">
      <button class="button" :disabled="busy">保存地址</button
      ><button type="button" :disabled="busy" @click="emit('cancel')">
        取消
      </button>
    </div>
  </form>
</template>
