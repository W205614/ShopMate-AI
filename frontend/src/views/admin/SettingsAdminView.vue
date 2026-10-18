<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { useShop } from "../../stores/shop";
import { api, refreshState } from "../../services/api";
import type { Settings } from "../../domain/types";
import { useAdminAction } from "./useAdmin";
const shop = useShop(),
  { busy, pending, run } = useAdminAction(),
  baseline = ref({ ...shop.db.settings }),
  baselineRevision = ref(shop.db.revision),
  form = reactive({ ...shop.db.settings });
const keys = ["name", "slogan", "notice"] as const;
const dirty = computed(() =>
  keys.some((key) => form[key] !== baseline.value[key]),
);
const conflict = computed(
  () =>
    shop.db.revision >= baselineRevision.value &&
    keys.some((key) => shop.db.settings[key] !== baseline.value[key]),
);
function loadLatest(
  settings: Settings = shop.db.settings,
  revision = shop.db.revision,
) {
  baseline.value = { ...settings };
  baselineRevision.value = revision;
  Object.assign(form, baseline.value);
}
async function reloadLatest() {
  await run(async () => {
    const value = await refreshState("admin");
    if (!value.sessions.admin) throw Error("登录已失效，请重新登录");
    loadLatest(value.db.settings, value.db.revision);
  }, "已加载最新设置，请重新编辑");
}
watch(
  () => shop.db.settings,
  () => {
    if (!dirty.value && shop.db.revision >= baselineRevision.value)
      loadLatest();
  },
);
async function save() {
  if (!form.name.trim() || !form.slogan.trim())
    return void run(async () => {
      throw Error("请填写商城名称和标语");
    });
  await run(async () => {
    const value = await api.saveSettings({ ...form, version: baseline.value.version ?? 1 }, { ...baseline.value });
    loadLatest(value.settings, value.revision);
  }, "商城信息已保存");
}
</script>
<template>
  <div class="admin-page-head">
    <div>
      <h1>演示设置</h1>
      <p>调整商城信息，了解本次演示的运行范围。</p>
    </div>
    <el-tag effect="plain">数据版本 {{ shop.db.version }}</el-tag>
  </div>
  <section class="admin-panel admin-settings-panel">
    <h2>商城基础信息</h2>
    <el-alert
      v-if="dirty && conflict"
      title="其他页面已更新设置，本地草稿已保留。请加载最新设置后重新编辑。"
      type="warning"
      :closable="false"
      show-icon
      role="alert"
    />
    <p v-if="dirty" class="admin-note">有尚未保存的修改。</p>
    <el-form
      class="admin-settings-form"
      label-position="top"
      @submit.prevent="save"
      ><el-form-item label="商城名称" required
        ><el-input
          v-model="form.name"
          maxlength="40"
          :disabled="busy" /></el-form-item
      ><el-form-item label="品牌标语" required
        ><el-input
          v-model="form.slogan"
          maxlength="80"
          :disabled="busy" /></el-form-item
      ><el-form-item label="商城公告"
        ><el-input
          v-model="form.notice"
          type="textarea"
          :rows="3"
          :disabled="busy"
          maxlength="200" /></el-form-item
      ><el-button
        type="primary"
        :loading="pending"
        :disabled="busy"
        @click="save"
        >保存信息</el-button
      ><el-button
        :disabled="busy || (!dirty && !conflict)"
        @click="reloadLatest"
        >加载最新设置</el-button
      ></el-form
    >
  </section>
  <section class="admin-panel admin-settings-panel">
    <h2>关于这个演示</h2>
    <dl class="admin-detail-list">
      <dt>数据保存</dt>
      <dd>
        账号、商品、订单、库存和客服数据保存在服务端 SQLite
        数据库，刷新或重建容器后保留。
      </dd>
      <dt>账号边界</dt>
      <dd>
        用户与管理员使用独立服务端会话，接口验证身份、角色和数据归属。管理员不开放公开注册。
      </dd>
      <dt>交易流程</dt>
      <dd>
        付款、退款、物流和采购支出均为模拟操作，不产生真实扣款或物流运单。
      </dd>
      <dt>客服能力</dt>
      <dd>
        基于商品、订单和 FAQ
        的规则回复，未连接真实大模型。人工回复可在另一商城标签页查看。
      </dd>
      <dt>设备范围</dt>
      <dd>同一服务端支持跨浏览器访问，需各自登录。页面定期同步服务端数据。</dd>
    </dl>
  </section>
</template>
