<script setup lang="ts">
import { reactive, watch } from "vue";
import { ElMessageBox } from "element-plus";
import { useShop } from "../../stores/shop";
import { api } from "../../services/api";
import { useAdminAction } from "./useAdmin";
const shop = useShop(),
  { busy, run } = useAdminAction(),
  form = reactive({ ...shop.db.settings });
watch(
  () => shop.db.settings,
  (s) => Object.assign(form, s),
);
async function save() {
  if (!form.name.trim() || !form.slogan.trim() || !form.notice.trim())
    return void run(async () => {
      throw Error("请填写商城名称、标语和公告");
    });
  await run(() => api.saveSettings({ ...form }), "商城信息已保存");
}
async function reset() {
  try {
    const result = await ElMessageBox.prompt(
      "此操作会清空当前浏览器内的演示订单、库存变动、流水和会话，恢复初始数据。请输入「恢复演示」确认。",
      "恢复初始数据",
      {
        confirmButtonText: "恢复初始数据",
        cancelButtonText: "取消",
        inputPattern: /^恢复演示$/,
        inputErrorMessage: "请输入完整的「恢复演示」",
        type: "warning",
      },
    );
    if (result.value === "恢复演示")
      await run(() => api.resetDemo(), "演示数据已恢复");
  } catch {
    /* dismissed */
  }
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
    <el-form
      class="admin-settings-form"
      label-position="top"
      @submit.prevent="save"
      ><el-form-item label="商城名称" required
        ><el-input v-model="form.name" maxlength="40" /></el-form-item
      ><el-form-item label="品牌标语" required
        ><el-input v-model="form.slogan" maxlength="80" /></el-form-item
      ><el-form-item label="商城公告"
        ><el-input
          v-model="form.notice"
          type="textarea"
          :rows="3"
          maxlength="200" /></el-form-item
      ><el-button type="primary" :loading="busy" @click="save"
        >保存信息</el-button
      ></el-form
    >
  </section>
  <section class="admin-panel admin-settings-panel">
    <h2>关于这个演示</h2>
    <dl class="admin-detail-list">
      <dt>数据保存</dt>
      <dd>
        商品、订单、库存和客服数据保存在当前浏览器。同源多标签页共享，刷新后恢复。
      </dd>
      <dt>账号边界</dt>
      <dd>
        用户与管理员使用独立演示身份。前端路由与数据筛选用于功能演示，后续需服务端认证和权限保护。
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
      <dd>不支持跨浏览器或跨设备同步。更换访问域名或端口也会使用独立数据。</dd>
    </dl>
  </section>
  <section class="admin-panel admin-settings-panel">
    <h2>恢复初始数据</h2>
    <p class="admin-muted" style="margin-bottom: 20px">
      用于重新体验完整流程。恢复后，当前浏览器的业务修改将被初始演示数据替换。
    </p>
    <el-button type="danger" plain :loading="busy" @click="reset"
      >恢复演示数据</el-button
    >
  </section>
</template>
