<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { useShop } from "../../stores/shop";
import { api } from "../../services/api";
import { money, dateTime } from "../../domain/types";
import type { Coupon } from "../../domain/types";
import { useAdminAction } from "./useAdmin";
import "../../styles/account-commerce.css";

const shop = useShop(),
  { busy, pending, run } = useAdminAction();
const dialog = ref(false),
  editingId = ref("");
const form = reactive({
  name: "",
  threshold: 100,
  discount: 10,
  claimStartsAt: "",
  claimEndsAt: "",
  validFrom: "",
  validUntil: "",
  totalLimit: 100,
  active: true,
});
const issued = computed(
  () =>
    !!editingId.value &&
    shop.db.couponClaims.some((claim) => claim.couponId === editingId.value),
);
const rows = computed(() => [...shop.db.coupons].reverse());
async function toggle(coupon: Coupon) {
  await run(
    () => api.toggleCoupon(coupon.id),
    coupon.active ? "已停止新领取及新订单使用" : "优惠券已启用",
  );
}
function localTime(date: Date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
}
function open(coupon?: Coupon) {
  editingId.value = coupon?.id ?? "";
  const now = new Date(),
    end = new Date(Date.now() + 30 * 86400_000);
  Object.assign(form, {
    name: coupon?.name ?? "",
    threshold: (coupon?.threshold ?? 10000) / 100,
    discount: (coupon?.discount ?? 1000) / 100,
    claimStartsAt: localTime(coupon ? new Date(coupon.claimStartsAt) : now),
    claimEndsAt: localTime(coupon ? new Date(coupon.claimEndsAt) : end),
    validFrom: localTime(coupon ? new Date(coupon.validFrom) : now),
    validUntil: localTime(coupon ? new Date(coupon.validUntil) : end),
    totalLimit: coupon?.totalLimit ?? 100,
    active: coupon?.active ?? true,
  });
  dialog.value = true;
}
async function save() {
  if (issued.value) return;
  if (
    await run(
      () =>
        api.saveCoupon({
          ...form,
          id: editingId.value || undefined,
          threshold: Math.round(form.threshold * 100),
          discount: Math.round(form.discount * 100),
          claimStartsAt: new Date(form.claimStartsAt).toISOString(),
          claimEndsAt: new Date(form.claimEndsAt).toISOString(),
          validFrom: new Date(form.validFrom).toISOString(),
          validUntil: new Date(form.validUntil).toISOString(),
        }),
      "优惠券已保存",
    )
  )
    dialog.value = false;
}
</script>
<template>
  <div class="admin-page-head">
    <div>
      <h1>优惠券管理</h1>
      <p>全店固定金额满减，优惠以服务端结算为准。</p>
    </div>
    <el-button type="primary" @click="open()">创建优惠券</el-button>
  </div>
  <section class="admin-panel">
    <el-table :data="rows" empty-text="暂无优惠券，创建后用户可在领券中心领取">
      <el-table-column prop="name" label="名称" min-width="160" />
      <el-table-column label="满减规则" min-width="160"
        ><template #default="{ row }"
          >满 {{ money(row.threshold) }} 减 {{ money(row.discount) }}</template
        ></el-table-column
      >
      <el-table-column label="已领 / 总量" width="130"
        ><template #default="{ row }"
          >{{
            shop.db.couponClaims.filter((c) => c.couponId === row.id).length
          }}
          / {{ row.totalLimit }}</template
        ></el-table-column
      >
      <el-table-column label="使用期限" min-width="195"
        ><template #default="{ row }"
          >{{ dateTime(row.validFrom) }}<br />至
          {{ dateTime(row.validUntil) }}</template
        ></el-table-column
      >
      <el-table-column label="状态" width="100"
        ><template #default="{ row }"
          ><el-tag :type="row.active ? 'success' : 'info'" effect="plain">{{
            row.active ? "已启用" : "已停用"
          }}</el-tag></template
        ></el-table-column
      >
      <el-table-column label="操作" fixed="right" width="150"
        ><template #default="{ row }"
          ><el-button link type="primary" @click="open(row)">查看配置</el-button
          ><el-button link :loading="pending" :disabled="busy" @click="toggle(row)">{{
            row.active ? "停用" : "启用"
          }}</el-button></template
        ></el-table-column
      >
    </el-table>
  </section>
  <el-dialog
    v-model="dialog"
    :title="editingId ? '优惠券配置' : '创建优惠券'"
    width="680px"
  >
    <el-alert
      v-if="issued"
      title="已有领取记录，配置已锁定。可在列表停用新领取和新订单使用，已创建订单不受影响。"
      type="info"
      :closable="false"
    />
    <el-form
      class="admin-commerce-form"
      label-position="top"
      @submit.prevent="save"
    >
      <el-form-item class="wide" label="优惠券名称"
        ><el-input
          v-model="form.name"
          aria-label="优惠券名称"
          maxlength="60"
          :disabled="issued"
          required
      /></el-form-item>
      <el-form-item label="使用门槛（元）"
        ><el-input-number
          v-model="form.threshold"
          aria-label="使用门槛（元）"
          :min="0.02"
          :step="0.01"
          :max="1000000"
          :precision="2"
          :disabled="issued"
      /></el-form-item>
      <el-form-item label="减免金额（元）"
        ><el-input-number
          v-model="form.discount"
          aria-label="减免金额（元）"
          :min="0.01"
          :step="0.01"
          :max="1000000"
          :precision="2"
          :disabled="issued"
      /></el-form-item>
      <label class="el-form-item"
        >领取开始<input
          v-model="form.claimStartsAt"
          aria-label="领取开始"
          type="datetime-local"
          :disabled="issued"
          required
      /></label>
      <label class="el-form-item"
        >领取结束<input
          v-model="form.claimEndsAt"
          aria-label="领取结束"
          type="datetime-local"
          :disabled="issued"
          required
      /></label>
      <label class="el-form-item"
        >使用开始<input
          v-model="form.validFrom"
          aria-label="使用开始"
          type="datetime-local"
          :disabled="issued"
          required
      /></label>
      <label class="el-form-item"
        >使用结束<input
          v-model="form.validUntil"
          aria-label="使用结束"
          type="datetime-local"
          :disabled="issued"
          required
      /></label>
      <el-form-item label="总发行量"
        ><el-input-number
          v-model="form.totalLimit"
          aria-label="总发行量"
          :min="1"
          :max="1000000"
          :precision="0"
          :disabled="issued"
      /></el-form-item>
      <el-form-item label="立即启用"
        ><el-switch
          v-model="form.active"
          aria-label="立即启用"
          :disabled="issued"
      /></el-form-item>
      <p class="admin-note wide">
        每人限领一次，单订单不可叠加；减免额须小于门槛。停用不影响已创建的待付款订单。
      </p>
      <div class="wide">
        <el-button
          v-if="!issued"
          type="primary"
          native-type="submit"
          :loading="pending" :disabled="busy"
          >保存优惠券</el-button
        >
      </div>
    </el-form>
    <template #footer
      ><el-button @click="dialog = false">关闭</el-button></template
    >
  </el-dialog>
</template>
