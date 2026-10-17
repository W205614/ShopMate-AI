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
      "此操作会清空服务端全部演示订单、地址、收藏、库存变动、流水和会话，恢复初始商品。已注册账号及登录会话保留。请输入「恢复演示」确认。",
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
        账号、商品、订单、库存和客服数据保存在服务端 SQLite 数据库，刷新或重建容器后保留。
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
  <section class="admin-panel admin-settings-panel">
    <h2>恢复初始数据</h2>
    <p class="admin-muted" style="margin-bottom: 20px">
      用于重新体验完整流程。恢复影响所有账号的业务数据，注册账号和密码保留。
    </p>
    <el-button type="danger" plain :loading="busy" @click="reset"
      >恢复演示数据</el-button
    >
  </section>
</template>
