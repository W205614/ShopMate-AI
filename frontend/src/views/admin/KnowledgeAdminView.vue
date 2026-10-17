<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { ElMessageBox } from "element-plus";
import { useShop } from "../../stores/shop";
import { api } from "../../services/api";
import type { Faq, FaqInput } from "../../domain/types";
import { useAdminAction } from "./useAdmin";
const shop = useShop(),
  { busy, pending, run } = useAdminAction(),
  query = ref(""),
  dialog = ref(false),
  keywords = ref("");
const form = reactive<FaqInput>({
  question: "",
  answer: "",
  keywords: [],
  active: true,
});
const rows = computed(() =>
  shop.db.faqs.filter(
    (f) =>
      !query.value ||
      f.question.includes(query.value) ||
      f.answer.includes(query.value) ||
      f.keywords.some((k) => k.includes(query.value)),
  ),
);
function open(f?: Faq) {
  Object.assign(
    form,
    f
      ? { ...f, keywords: [...f.keywords] }
      : { id: undefined, question: "", answer: "", keywords: [], active: true },
  );
  keywords.value = form.keywords.join("，");
  dialog.value = true;
}
async function save() {
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
    await run(
      () => api.saveFaq({ ...form, keywords: list }),
      "FAQ 已保存，模拟客服即时生效",
    )
  )
    dialog.value = false;
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
      <p>维护规则回复，让常见问题得到一致解答。</p>
    </div>
    <el-button type="primary" @click="open()">新增问答</el-button>
  </div>
  <div class="admin-callout">
    此处为关键词规则演示，不涉及向量检索或大模型训练。启用的问答参与模拟客服匹配。
  </div>
  <section class="admin-panel">
    <div class="admin-toolbar">
      <el-input
        v-model="query"
        clearable
        placeholder="搜索问题、回答或关键词"
      />
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
          ><el-button link type="primary" @click="open(row)">编辑</el-button
          ><el-button link type="danger" @click="remove(row)"
            >删除</el-button
          ></template
        ></el-table-column
      ></el-table
    >
  </section>
  <el-dialog
    v-model="dialog"
    :title="form.id ? '编辑问答' : '新增问答'"
    width="620px"
    ><el-form label-position="top" @submit.prevent="save"
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
      ><el-button @click="dialog = false">取消</el-button
      ><el-button type="primary" :loading="pending" :disabled="busy" @click="save"
        >保存</el-button
      ></template
    ></el-dialog
  >
</template>
