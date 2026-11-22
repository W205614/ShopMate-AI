<script setup lang="ts">
import { ref, watch } from "vue";
import type { DeliveryEstimate } from "../../../../shared/domain/operations";
import { money } from "../../domain/types";
import { request } from "../../services/repository";
import DeliveryProvinceField from "./DeliveryProvinceField.vue";
import { canonicalProvince } from "../../../../shared/domain/delivery-province";

const props = defineProps<{
  productId: string;
  skuId: string;
  quantity: number;
}>();
const province = defineModel<string>({ required: true });
const estimate = ref<DeliveryEstimate>();
const error = ref("");
const busy = ref(false);
let sequence = 0;

watch(
  [() => props.productId, () => props.skuId, () => props.quantity, province],
  () => {
    sequence++;
    estimate.value = undefined;
    error.value = "";
    busy.value = false;
  },
  { flush: "sync" },
);

async function calculate() {
  const current = ++sequence;
  const query = new window.URLSearchParams({
    province: canonicalProvince(province.value),
    sku: props.skuId,
    quantity: String(props.quantity),
  });
  busy.value = true;
  error.value = "";
  estimate.value = undefined;
  try {
    const result = await request<DeliveryEstimate>(
      `/api/products/${encodeURIComponent(props.productId)}/delivery-estimate?${query}`,
    );
    if (current === sequence) estimate.value = result;
  } catch (cause) {
    if (current === sequence)
      error.value =
        cause instanceof Error ? cause.message : "无法读取运费，请重试";
  } finally {
    if (current === sequence) busy.value = false;
  }
}
</script>

<template>
  <form class="form-stack" @submit.prevent="calculate">
    <DeliveryProvinceField v-model="province" />
    <button
      class="button secondary-button"
      :disabled="busy || !province"
      type="submit"
    >
      {{ busy ? "正在试算…" : "试算运费" }}
    </button>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="estimate" role="status">
      <template v-if="estimate.deliverable">
        预估运费 {{ money(estimate.fee) }} · {{ estimate.ruleName }}
        <template v-if="estimate.freeAbove">
          · 满 {{ money(estimate.freeAbove) }} 包邮</template
        >
        <template v-if="estimate.freeShippingGap">
          · 距包邮还差 {{ money(estimate.freeShippingGap) }}
        </template>
      </template>
      <template v-else>该地区暂不配送。</template>
    </p>
    <p class="secondary">
      按当前规格、数量及优惠前金额预估。结算按实际商品与优惠重新计算。
    </p>
  </form>
</template>
