<script setup lang="ts">
import { useId } from "vue";
import {
  canonicalProvince,
  deliveryProvinces,
} from "../../../../shared/domain/delivery-province";

const province = defineModel<string>({ required: true });
const options = useId();
</script>

<template>
  <label>
    配送省份
    <input
      v-model.trim="province"
      :list="options"
      autocomplete="address-level1"
      maxlength="30"
      placeholder="输入或选择省份"
      required
      @change="province = canonicalProvince(province)"
    />
    <datalist :id="options">
      <option v-for="name in deliveryProvinces" :key="name" :value="name" />
    </datalist>
  </label>
</template>
