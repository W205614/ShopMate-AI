<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import SupportDocumentsPanel from "./SupportDocumentsPanel.vue";
import { ElMessageBox } from "element-plus";
import { useShop } from "../../stores/shop";
import { api } from "../../services/api";
import type { Faq, FaqInput } from "../../domain/types";
import { useAdminAction } from "./useAdmin";
import { useAdminQuery, useAdminPagination } from "./useAdminList";
import { useAdminEditor } from "./useAdminEditor";
const shop = useShop(),
  { busy, pending, run } = useAdminAction(),
  filters = useAdminQuery(),
  query = filters.field("q", { replace: true }),
  status = filters.field("status", { values: ["active", "inactive"] }),
  keywords = ref("");
const form = reactive<FaqInput>({
  question: "",
  answer: "",
  keywords: [],
  active: true,
});
const filtered = computed(() =>
  shop.db.faqs.filter(
    (f) =>
      (!status.value || f.active === (status.value === "active")) &&
      (!query.value.trim() ||
        [f.question, f.answer, ...f.keywords].some((value) =>
          value.toLowerCase().includes(query.value.trim().toLowerCase()),
        )),
  ),
);
const { page, rows, total } = useAdminPagination(filtered, filters);
const { dialog, detailId, missing, open, capture, finish, assertCurrent } =
  useAdminEditor(
    computed(() => shop.db.faqs),
    filters,
    load,
    () => pending.value,
    () => shop.adminSession?.id,
  );
function load(f?: Faq) {
  Object.assign(
    form,
    f
      ? { ...f, keywords: [...f.keywords] }
      : { id: undefined, question: "", answer: "", keywords: [], active: true },
  );
  keywords.value = form.keywords.join("，");
}
async function save() {
  const target = capture();
  const list = [
    ...new Set(
      keywords.value
        .split(/[,，\n]/)
        .map((k) => k.trim())
        .filter(Boolean),
    ),
  ];
  if (!form.question.trim() || !form.answer.trim() || !list.length)
    return void run(async () => {
      throw Error("请填写问题、回答及至少一个关键词");
    });
  if (
    await run(() => {
      assertCurrent(target);
      return api.saveFaq({ ...form, keywords: list });
    }, "FAQ 已保存，即时更新客服知识")
  )
    finish(target);
}
async function remove(f: Faq) {
  try {
    await ElMessageBox.confirm("确认删除这条 FAQ？", "删除 FAQ", {
      type: "warning",
    });
    await run(() => api.deleteFaq(f.id), "FAQ 已删除");
  } catch {
    /* dismissed */
  }
}
async function toggle(f: Faq) {
  await run(() => api.saveFaq({ ...f, active: !f.active }), "启用状态已更新");
}
</script>
<template>
  <div class="admin-page-head">
    <div>
      <h1>FAQ 管理</h1>
      <p>维护常见问答与已核对的文档，让客服回答有据可查。</p>
    </div>
    <el-button type="primary" :disabled="pending" @click="open()"
      >新增问答</el-button
    >
  </div>
  <div class="admin-callout">
    启用的 FAQ 参与规则回复和 AI
    知识检索；文档需完成处理、人工核对并发布后才生效。
  </div>
  <section class="admin-panel">
    <div class="admin-toolbar">
      <el-input
        v-model="query"
        maxlength="100"
        clearable
        placeholder="搜索问题、回答或关键词"
      />
      <el-select v-model="status" placeholder="全部启停状态" clearable
        ><el-option label="已启用" value="active" /><el-option
          label="已停用"
          value="inactive" /></el-select
      ><span class="admin-note">{{ total }} 条问答</span>
    </div>
    <el-table :data="rows" empty-text="暂无匹配的问答"
      ><el-table-column
        prop="question"
        label="问题"
        min-width="200"
      /><el-table-column label="关键词" min-width="160"
        ><template #default="{ row }">{{
          row.keywords.join("、")
        }}</template></el-table-column
      ><el-table-column
        prop="answer"
        label="回复内容"
        min-width="280"
        show-overflow-tooltip
      /><el-table-column label="状态" width="110"
        ><template #default="{ row }"
          ><el-switch
            :model-value="row.active"
            :disabled="busy"
            :aria-label="'启用' + row.question"
            @change="toggle(row)" /></template></el-table-column
      ><el-table-column label="操作" width="130" fixed="right"
        ><template #default="{ row }"
          ><el-button link type="primary" :disabled="pending" @click="open(row)"
            >编辑</el-button
          ><el-button link type="danger" @click="remove(row)"
            >删除</el-button
          ></template
        ></el-table-column
      ></el-table
    >
    <div class="admin-pagination">
      <el-pagination
        v-model:current-page="page"
        :page-size="10"
        :total="total"
        layout="prev,pager,next,total"
      />
    </div>
  </section>
  <SupportDocumentsPanel />
  <el-dialog
    v-model="dialog"
    :title="detailId ? '编辑问答' : '新增问答'"
    width="620px"
    :close-on-click-modal="!pending"
    :close-on-press-escape="!pending"
    :show-close="!pending"
    ><el-alert
      v-if="missing"
      title="没有找到该问答"
      type="warning"
      :closable="false"
    /><el-form
      v-else
      label-position="top"
      :disabled="pending"
      @submit.prevent="save"
      ><el-form-item label="常见问题" required
        ><el-input v-model="form.question" maxlength="100" /></el-form-item
      ><el-form-item label="匹配关键词（用逗号分隔）" required
        ><el-input
          v-model="keywords"
          placeholder="配送，运费，包邮" /></el-form-item
      ><el-form-item label="回复内容" required
        ><el-input
          v-model="form.answer"
          type="textarea"
          :rows="6"
          maxlength="2000" /></el-form-item
      ><el-checkbox v-model="form.active">启用问答</el-checkbox></el-form
    ><template #footer
      ><el-button :disabled="pending" @click="dialog = false">取消</el-button
      ><el-button
        v-if="!missing"
        type="primary"
        :loading="pending"
        :disabled="busy"
        @click="save"
        >保存</el-button
      ></template
    ></el-dialog
  >
</template>
