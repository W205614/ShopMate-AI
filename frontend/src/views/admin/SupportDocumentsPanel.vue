<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from "vue";
import { ElMessageBox } from "element-plus";
import { useShop } from "../../stores/shop";
import { request } from "../../services/repository";
import {
  documentCommand,
  documentLabels,
  processingDocument,
} from "../../services/supportDocuments";
import type { SupportDocument } from "../../services/supportDocuments";
import { dateTime } from "../../domain/types";
import { useAdminAction } from "./useAdmin";

const shop = useShop(),
  { busy, pending, run } = useAdminAction(),
  documents = ref<SupportDocument[]>([]),
  fileInput = ref<HTMLInputElement>(),
  editor = ref<SupportDocument | null>(null),
  text = ref(""),
  dialog = ref(false),
  readError = ref("");
let alive = true,
  epoch = 0,
  reads = 0,
  editorReads = 0,
  timer: ReturnType<typeof setTimeout> | undefined;
const capture = () => ({ epoch, actor: shop.adminSession?.id });
const current = (target: ReturnType<typeof capture>) =>
  alive && target.epoch === epoch && target.actor === shop.adminSession?.id;
const path = (id: string) => `/api/support/documents/${encodeURIComponent(id)}`;
async function refresh() {
  clearTimeout(timer);
  const target = capture(),
    sequence = ++reads;
  if (!target.actor) return;
  try {
    const result = await request<{ documents: SupportDocument[] }>(
      "/api/support/documents",
    );
    if (!current(target) || sequence !== reads) return;
    documents.value = result.documents;
    readError.value = "";
    if (documents.value.some(processingDocument))
      timer = setTimeout(() => void refresh(), 1500);
  } catch (error) {
    if (!current(target) || sequence !== reads) return;
    readError.value =
      error instanceof Error ? error.message : "读取知识文档失败";
    if (documents.value.some(processingDocument))
      timer = setTimeout(() => void refresh(), 4000);
  }
}
async function upload(event: Event) {
  const input = event.target as HTMLInputElement,
    file = input.files?.[0];
  if (!file) return;
  const target = capture();
  await run(async () => {
    if (!/\.(txt|md|markdown|docx|pdf|png|jpe?g|webp)$/i.test(file.name))
      throw Error("请选择支持的文档或图片格式");
    if (file.size > 10 * 1024 * 1024) throw Error("单个文件不能超过 10 MiB");
    if (!file.size) throw Error("不能上传空文件");
    const contentBase64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
      reader.onerror = () => reject(Error("文件读取失败，请重新选择"));
      reader.readAsDataURL(file);
    });
    if (!current(target)) throw Error("登录身份已变化，请重新上传");
    await documentCommand("/api/support/documents", {
      name: file.name,
      contentBase64,
    });
    if (current(target)) await refresh();
  }, "文档已提交处理，请核对提取文本后手动发布。");
  input.value = "";
}
async function open(document: SupportDocument) {
  const target = capture(),
    sequence = ++editorReads;
  await run(async () => {
    const value = await request<{ document: SupportDocument }>(
      path(document.id),
    );
    if (!current(target) || sequence !== editorReads) return;
    editor.value = value.document;
    text.value = value.document.text;
    dialog.value = true;
  }, "已读取文档");
}
async function mutate(
  document: SupportDocument,
  action: "save" | "publish" | "disable" | "delete" | "retry",
) {
  const target = capture(),
    savedText = text.value;
  if (action === "delete" || action === "publish") {
    try {
      await ElMessageBox.confirm(
        action === "delete"
          ? `确认删除「${document.name}」及其检索内容？`
          : `确认已核对「${document.name}」的识别文本？发布后顾客可以检索该版本。`,
        action === "delete" ? "删除知识文档" : "发布知识文档",
        { type: action === "delete" ? "warning" : "info" },
      );
    } catch {
      return;
    }
  }
  if (!current(target)) return;
  await run(
    async () => {
      await documentCommand(`${path(document.id)}/actions`, {
        action,
        version: document.version,
        ...(action === "save" ? { text: savedText } : {}),
      });
      if (!current(target)) return;
      if (editor.value?.id === document.id) {
        dialog.value = false;
        editor.value = null;
      }
      await refresh();
    },
    action === "save"
      ? "新版本已保存，完成索引后请重新核对并发布。"
      : "文档状态已更新",
  );
}
watch(
  () => shop.adminSession?.id,
  () => {
    epoch++;
    reads++;
    editorReads++;
    clearTimeout(timer);
    documents.value = [];
    editor.value = null;
    dialog.value = false;
    text.value = "";
    readError.value = "";
    ElMessageBox.close();
    void refresh();
  },
  { flush: "sync" },
);
onMounted(refresh);
onUnmounted(() => {
  alive = false;
  epoch++;
  clearTimeout(timer);
  ElMessageBox.close();
});
</script>

<template>
  <section
    class="admin-panel support-documents"
    data-testid="support-documents"
  >
    <div class="document-heading">
      <div>
        <h2>文档知识库</h2>
        <p class="admin-note">
          支持 TXT、Markdown、DOCX、PDF、PNG、JPEG、WebP；每份不超过 10 MiB，PDF
          最多 30 页。识别内容需人工核对后发布。
        </p>
      </div>
      <div>
        <el-button :disabled="busy" @click="refresh">刷新文档</el-button
        ><el-button type="primary" :disabled="busy" @click="fileInput?.click()"
          >上传文档</el-button
        >
      </div>
      <input
        ref="fileInput"
        class="document-file"
        type="file"
        accept=".txt,.md,.markdown,.docx,.pdf,.png,.jpg,.jpeg,.webp"
        aria-label="选择知识文档"
        :disabled="busy"
        @change="upload"
      />
    </div>
    <el-alert
      v-if="readError"
      :title="readError"
      type="error"
      :closable="false"
    />
    <el-table :data="documents" empty-text="暂无知识文档，请上传并核对后发布">
      <el-table-column
        prop="name"
        label="文件名"
        min-width="180"
        show-overflow-tooltip
      />
      <el-table-column label="处理状态" min-width="140"
        ><template #default="{ row }"
          ><el-tag
            :type="
              row.status === 'failed'
                ? 'danger'
                : row.status === 'published'
                  ? 'success'
                  : 'info'
            "
            >{{
              documentLabels[row.status as SupportDocument["status"]]
            }}</el-tag
          >
          <p v-if="row.error" class="document-error">
            {{ row.error }}
          </p></template
        ></el-table-column
      >
      <el-table-column label="版本" min-width="130"
        ><template #default="{ row }"
          >当前 {{ row.version }} · 发布
          {{ row.publishedVersion ?? "无" }}</template
        ></el-table-column
      >
      <el-table-column label="更新于" min-width="170"
        ><template #default="{ row }">{{
          dateTime(row.updatedAt)
        }}</template></el-table-column
      >
      <el-table-column label="操作" width="250" fixed="right"
        ><template #default="{ row }">
          <el-button link type="primary" :disabled="busy" @click="open(row)"
            >核对文本</el-button
          >
          <el-button
            v-if="row.publishedVersion !== null"
            link
            :disabled="busy"
            @click="mutate(row, 'disable')"
            >停用</el-button
          >
          <el-button
            v-if="row.status === 'failed' || row.status === 'disabled'"
            link
            type="primary"
            :disabled="busy"
            @click="mutate(row, 'retry')"
            >{{ row.status === "disabled" ? "恢复为草稿" : "重试" }}</el-button
          >
          <el-button
            link
            type="danger"
            :disabled="busy"
            @click="mutate(row, 'delete')"
            >删除</el-button
          >
        </template></el-table-column
      >
    </el-table>
    <p class="admin-note">
      仅已发布版本参与顾客检索。编辑已发布文档后，原发布版本持续生效，直到新版本发布或主动停用；原文件仅管理端可访问。
    </p>
  </section>
  <el-dialog
    v-model="dialog"
    title="核对知识文档"
    width="min(800px, 95vw)"
    :close-on-click-modal="!pending"
    :close-on-press-escape="!pending"
    :show-close="!pending"
    @closed="editor = null"
  >
    <template v-if="editor">
      <p>
        {{ editor.name }} · {{ documentLabels[editor.status] }} · 第
        {{ editor.version }} 版
      </p>
      <el-alert
        v-if="editor.error"
        :title="editor.error"
        type="error"
        :closable="false"
      />
      <el-alert
        v-if="processingDocument(editor)"
        title="文档仍在处理，请关闭后等待处理完成再核对文本。"
        type="info"
        :closable="false"
      />
      <label for="document-text"
        >提取文本（请重点核对金额、否定语句与复杂表格）</label
      >
      <el-input
        id="document-text"
        v-model="text"
        type="textarea"
        :rows="14"
        :disabled="pending || processingDocument(editor)"
      />
      <a :href="`${path(editor.id)}/file`" class="document-download" download
        >下载原始文件</a
      >
    </template>
    <template #footer>
      <el-button :disabled="pending" @click="dialog = false">关闭</el-button>
      <el-button
        v-if="editor && !processingDocument(editor)"
        :disabled="busy || text === editor.text || !text.trim()"
        @click="mutate(editor, 'save')"
        >保存并重新索引</el-button
      >
      <el-button
        v-if="editor?.status === 'draft'"
        type="primary"
        :disabled="busy || text !== editor.text"
        @click="mutate(editor, 'publish')"
        >核对完成，发布</el-button
      >
    </template>
  </el-dialog>
</template>

<style scoped>
.support-documents {
  margin-top: 24px;
}
.document-heading {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  margin-bottom: 16px;
}
.document-heading h2 {
  font-size: 18px;
  margin: 0 0 8px;
}
.document-heading p {
  max-width: 680px;
  line-height: 1.6;
}
.document-file {
  display: none;
}
.document-error {
  color: #b45338;
  font-size: 12px;
  overflow-wrap: anywhere;
}
.document-download {
  display: inline-block;
  margin-top: 14px;
}
label {
  display: block;
  margin: 16px 0 8px;
}
</style>
