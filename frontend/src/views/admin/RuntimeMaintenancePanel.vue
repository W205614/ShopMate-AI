<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { ElMessageBox } from "element-plus";
import { useShop } from "../../stores/shop";
import {
  commerceAction,
  getPendingCommands,
  resolvePendingCommand,
} from "../../services/api";
import { request, RequestError } from "../../services/repository";
import { useAdminAction } from "./useAdmin";

const props = defineProps<{ mode: "jobs" | "runtime" }>();
type Job = {
  id: string;
  kind: string;
  status: "pending" | "done" | "failed";
  attempts: number;
  runAfter: number;
  lastError: string | null;
  retryVersion: number;
};
type Diagnostics = {
  at: string;
  startedAt: string;
  version: {
    revisionRef: string;
    schemaVersion: number;
    businessVersion: number;
    node: string;
  };
  requests: {
    active: number;
    completed: number;
    overloaded: number;
    databaseBusy: number;
  };
  jobs: { pending: number; failed: number; oldestWaitingMs: number };
  ai: {
    enabled: boolean;
    support: { status: string; count: number }[];
    documents: { status: string; count: number }[];
  };
  backup: {
    enabled: boolean;
    running: boolean;
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
    lastErrorCode: string | null;
    replicaConfigured: boolean;
    lastReplicaSnapshotAt: string | null;
  };
};
const shop = useShop(),
  { busy, pending, run } = useAdminAction();
const loading = ref(false),
  error = ref(""),
  loadedAt = ref(""),
  diagnostics = ref<Diagnostics>(),
  jobs = ref<Job[]>([]),
  status = ref("all"),
  page = ref(1),
  total = ref(0),
  pages = ref(1),
  originalRetry = ref<Job>();
const recoveryCommands = ref(
  getPendingCommands().filter((c) => c.method === "retryJob"),
);
const permitted = computed(() =>
  shop.adminSession?.permissions?.includes("settings"),
);
let alive = true,
  sequence = 0;
const actor = shop.adminSession?.id;
const current = () =>
  alive && actor === shop.adminSession?.id && permitted.value;
function assertCurrent() {
  if (!current()) throw new Error("管理员身份或工作区已变化，请重新核对后操作");
}
function beijing(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === "") return "暂无记录";
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(date)
    : "时间无效";
}
const jobStatus = (value: string) =>
  ({ pending: "待执行", done: "已完成", failed: "已失败" })[value] ??
  "未知状态";
const kindLabel = (value: string) =>
  ({ notification: "站内通知", expiry: "订单过期与清理" })[value] ??
  "未知任务类型";
function stateCounts(rows: { status: string; count: number }[]) {
  const labels: Record<string, string> = {
    queued: "排队",
    running: "处理中",
    failed: "失败",
    extracting: "识别中",
    indexing: "索引中",
  };
  return rows.length
    ? rows
        .map((row) => `${labels[row.status] ?? "其他状态"} ${row.count}`)
        .join("；")
    : "无排队、处理中或失败任务";
}
const backupStale = computed(() => {
  if (!diagnostics.value) return false;
  const { lastSuccessAt } = diagnostics.value.backup,
    now = Date.parse(diagnostics.value.at),
    success = Date.parse(lastSuccessAt ?? "");
  return (
    !Number.isFinite(success) || success > now || now - success > 23 * 3600000
  );
});
async function load() {
  if (!current()) return;
  const ticket = ++sequence;
  loading.value = true;
  error.value = "";
  try {
    if (props.mode === "runtime") {
      const result = await request<Diagnostics>("/api/admin/diagnostics");
      if (!current() || ticket !== sequence) return;
      diagnostics.value = result;
      loadedAt.value = result.at;
    } else {
      const result = await request<{
        items: Job[];
        total: number;
        page: number;
        pages: number;
      }>(
        `/api/admin/jobs?status=${status.value}&page=${page.value}&pageSize=20`,
      );
      if (!current() || ticket !== sequence) return;
      jobs.value = result.items;
      total.value = result.total;
      pages.value = result.pages;
      // The server clamps out-of-range pages after a retry removes a failed row.
      if (page.value !== result.page) page.value = result.page;
      loadedAt.value = new Date().toISOString();
    }
  } catch (failure) {
    if (current() && ticket === sequence)
      error.value =
        failure instanceof Error ? failure.message : "读取失败，请重试";
  } finally {
    if (current() && ticket === sequence) loading.value = false;
  }
}
function selectStatus(value: string) {
  status.value = value;
  page.value = 1;
}
async function submitRetry(job: Job) {
  await run(async () => {
    assertCurrent();
    originalRetry.value = { ...job };
    try {
      await commerceAction("retryJob", job.id, job.retryVersion);
      assertCurrent();
      originalRetry.value = undefined;
      recoveryCommands.value = [];
      await load();
    } catch (failure) {
      if (current()) {
        if (failure instanceof RequestError && failure.outcome === "rejected") {
          originalRetry.value = undefined;
          if (failure.status === 409) await load();
        }
        recoveryCommands.value = getPendingCommands().filter(
          (c) => c.method === "retryJob",
        );
      }
      throw failure;
    }
  }, "任务已重新排队，请刷新查看执行结果");
}
async function retry(job: Job) {
  if (busy.value || originalRetry.value || recoveryCommands.value.length)
    return;
  try {
    await ElMessageBox.confirm(
      `确认已排除失败原因后，重新排队任务 ${job.id}。不会修改任务内容，操作将记录审计。`,
      "重试失败任务",
      {
        confirmButtonText: "确认重试",
        cancelButtonText: "取消",
        type: "warning",
      },
    );
  } catch {
    return;
  }
  if (current()) await submitRetry(job);
}
async function resolveOriginal() {
  await run(async () => {
    assertCurrent();
    const commands = getPendingCommands().filter(
      (c) => c.method === "retryJob",
    );
    for (const command of commands) {
      const found = await resolvePendingCommand(command);
      assertCurrent();
      if (!found)
        throw new Error(
          "原请求尚无成功结果；保留本页时可按原参数重试，请勿更换任务重复提交",
        );
    }
    originalRetry.value = undefined;
    recoveryCommands.value = [];
    await load();
  }, "已核对上次请求，请查看任务最新状态");
}
watch([() => props.mode, status, page], () => void load(), { immediate: true });
watch(
  () => shop.adminSession?.id,
  () => {
    sequence++;
    jobs.value = [];
    diagnostics.value = undefined;
    originalRetry.value = undefined;
    recoveryCommands.value = [];
    loadedAt.value = "";
    error.value = "";
  },
  { flush: "sync" },
);
onUnmounted(() => {
  alive = false;
  sequence++;
});
</script>

<template>
  <section
    class="maintenance-panel"
    :aria-label="mode === 'runtime' ? '运行状态' : '后台任务'"
  >
    <div class="admin-toolbar">
      <template v-if="mode === 'jobs'">
        <label for="maintenance-status">任务状态</label>
        <select
          id="maintenance-status"
          :value="status"
          @change="selectStatus(($event.target as HTMLSelectElement).value)"
        >
          <option value="all">全部状态</option>
          <option value="failed">已失败</option>
          <option value="pending">待执行</option>
          <option value="done">已完成</option>
        </select>
        <span>共 {{ total }} 条</span>
      </template>
      <el-button :loading="loading" :disabled="loading || pending" @click="load"
        >刷新{{ mode === "runtime" ? "运行状态" : "任务" }}</el-button
      >
      <span v-if="loadedAt">读取于 {{ beijing(loadedAt) }}（北京时间）</span>
    </div>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <template v-if="mode === 'jobs'">
      <el-alert
        v-if="originalRetry || recoveryCommands.length"
        title="上次重试结果需要核对，请先处理原请求。"
        type="warning"
        :closable="false"
      />
      <div
        v-if="originalRetry || recoveryCommands.length"
        class="admin-toolbar"
      >
        <el-button :disabled="busy" @click="resolveOriginal"
          >核对上次请求</el-button
        >
        <el-button
          v-if="originalRetry"
          :disabled="busy"
          @click="submitRetry(originalRetry)"
          >按原参数重试</el-button
        >
      </div>
      <p>
        先排除失败原因再重试。待执行任务由后台自动处理；已完成任务不可重复重排。时间均为北京时间。
      </p>
      <el-table :data="jobs" row-key="id" empty-text="当前筛选下没有任务">
        <el-table-column prop="id" label="任务编号" min-width="190" />
        <el-table-column label="类型" min-width="150"
          ><template #default="{ row }">{{
            kindLabel(row.kind)
          }}</template></el-table-column
        >
        <el-table-column label="状态" width="100"
          ><template #default="{ row }">{{
            jobStatus(row.status)
          }}</template></el-table-column
        >
        <el-table-column prop="attempts" label="自动尝试次数" width="120" />
        <el-table-column label="计划执行时间" min-width="175"
          ><template #default="{ row }">{{
            beijing(row.runAfter)
          }}</template></el-table-column
        >
        <el-table-column label="失败代码" min-width="180" show-overflow-tooltip
          ><template #default="{ row }">{{
            row.lastError ?? "无"
          }}</template></el-table-column
        >
        <el-table-column label="处置" min-width="230"
          ><template #default="{ row }">
            <el-button
              v-if="
                row.status === 'failed' &&
                ['notification', 'expiry'].includes(row.kind)
              "
              :disabled="busy || !!originalRetry || !!recoveryCommands.length"
              @click="retry(row)"
              >重试任务</el-button
            >
            <span v-else>{{
              row.status === "failed"
                ? "未知类型，请维护人员检查"
                : row.status === "done"
                  ? "无需处置"
                  : "等待自动执行"
            }}</span>
          </template></el-table-column
        >
      </el-table>
      <el-pagination
        v-if="pages > 1"
        v-model:current-page="page"
        :total="total"
        :page-size="20"
        layout="prev, pager, next"
      />
    </template>
    <template v-else-if="diagnostics">
      <p>
        按需读取的运行快照；请求计数在进程重启后重置。此页面不代表外部告警已经接通。
      </p>
      <el-descriptions title="版本与请求" :column="2" border>
        <el-descriptions-item label="运行提交">{{
          diagnostics.version.revisionRef
        }}</el-descriptions-item>
        <el-descriptions-item label="进程启动">{{
          beijing(diagnostics.startedAt)
        }}</el-descriptions-item>
        <el-descriptions-item label="结构 / 业务版本"
          >{{ diagnostics.version.schemaVersion }} /
          {{ diagnostics.version.businessVersion }}</el-descriptions-item
        >
        <el-descriptions-item label="Node 运行时">{{
          diagnostics.version.node
        }}</el-descriptions-item>
        <el-descriptions-item label="在途 / 已结束请求"
          >{{ diagnostics.requests.active }} /
          {{ diagnostics.requests.completed }}</el-descriptions-item
        >
        <el-descriptions-item label="繁忙拒绝 / 数据库繁忙"
          >{{ diagnostics.requests.overloaded }} /
          {{ diagnostics.requests.databaseBusy }}</el-descriptions-item
        >
      </el-descriptions>
      <el-descriptions title="任务与 AI" :column="1" border>
        <el-descriptions-item label="业务任务"
          >待执行 {{ diagnostics.jobs.pending }}；失败
          {{ diagnostics.jobs.failed }}；最老到期等待
          {{
            Math.round(diagnostics.jobs.oldestWaitingMs / 1000)
          }}
          秒</el-descriptions-item
        >
        <el-descriptions-item label="AI 客服"
          >{{ diagnostics.ai.enabled ? "已启用" : "未启用，使用规则客服" }}；{{
            stateCounts(diagnostics.ai.support)
          }}</el-descriptions-item
        >
        <el-descriptions-item label="文档处理">{{
          stateCounts(diagnostics.ai.documents)
        }}</el-descriptions-item>
      </el-descriptions>
      <el-alert
        v-if="
          diagnostics.jobs.failed || diagnostics.jobs.oldestWaitingMs > 300000
        "
        title="任务存在失败或积压，请到后台任务筛选检查；排除原因后重试失败任务。"
        type="warning"
        :closable="false"
      />
      <el-descriptions title="备份恢复点" :column="1" border>
        <el-descriptions-item label="自动备份"
          >{{ diagnostics.backup.enabled ? "已启用" : "未启用" }}；{{
            diagnostics.backup.running ? "正在备份" : "当前空闲"
          }}</el-descriptions-item
        >
        <el-descriptions-item label="最近成功">{{
          beijing(diagnostics.backup.lastSuccessAt)
        }}</el-descriptions-item>
        <el-descriptions-item label="最近失败 / 代码"
          >{{ beijing(diagnostics.backup.lastFailureAt) }} /
          {{ diagnostics.backup.lastErrorCode ?? "无" }}</el-descriptions-item
        >
        <el-descriptions-item label="备份副本"
          >{{
            diagnostics.backup.replicaConfigured
              ? `已配置，快照时间 ${beijing(diagnostics.backup.lastReplicaSnapshotAt)}`
              : "未配置"
          }}；异机恢复未验证</el-descriptions-item
        >
      </el-descriptions>
      <el-alert
        v-if="
          !diagnostics.backup.enabled ||
          backupStale ||
          diagnostics.backup.lastErrorCode
        "
        title="备份未启用、恢复点缺失 / 超过 23 小时或备份失败。请检查磁盘和目录权限，再按运维文档核验完整备份。"
        type="warning"
        :closable="false"
      />
    </template>
    <p v-else-if="loading">正在读取运行状态…</p>
  </section>
</template>

<style scoped>
.maintenance-panel {
  display: grid;
  gap: 16px;
  min-width: 0;
}
.maintenance-panel p {
  margin: 0;
  color: var(--text-secondary, #666);
}
.maintenance-panel select {
  padding: 8px 12px;
  border: 1px solid #dcdfe6;
  border-radius: 4px;
  background: #fff;
  color: #303133;
  font: inherit;
}
</style>
