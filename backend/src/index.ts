import { openDatabase } from "./database";
import { createApp } from "./app";
import { createAccount } from "./auth";
import { registerSchema } from "./validation";
import { expirePendingOrders } from "./commerce";
import { writeFileSync, rmSync } from "node:fs";
import { ensureRuntimeSchema } from "./runtime";
import { runDueJobs, ensureRecurringJobs } from "./jobs";
import { runAutomaticBackup, cancelAutomaticBackup } from "./automatic-backup";
import { join } from "node:path";
import { startSupportWorker } from "./ai-support";
import { startKnowledgeWorker } from "./ai-knowledge";

const databasePath = process.env.DATABASE_PATH ?? "data/shopmate.sqlite";
const sql = openDatabase(databasePath);
ensureRuntimeSchema(sql);
ensureRecurringJobs(sql);
writeFileSync(
  databasePath + ".running",
  JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
);
expirePendingOrders(sql);
const expiryTimer = setInterval(() => {
  try {
    runDueJobs(sql);
  } catch (error) {
    console.error("订单超时处理失败", error);
  }
}, 1000);
expiryTimer.unref();
if (!sql.prepare("SELECT id FROM accounts WHERE role='admin'").get()) {
  const username = process.env.ADMIN_USERNAME ?? "admin";
  const password = process.env.ADMIN_PASSWORD;
  if (!password)
    throw new Error(
      "首次启动必须设置 ADMIN_PASSWORD（10–128 位，包含字母和数字）",
    );
  const input = registerSchema.parse({
    username,
    password,
    name: "商城管理员",
  });
  await createAccount(sql, input, "admin");
  console.log("管理员已初始化；后续重启不会覆盖账号或密码。");
}
const app = await createApp(sql, {
  origins: (
    process.env.APP_ORIGINS ??
    "http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:18086,http://localhost:18086"
  ).split(","),
  secureCookies: process.env.COOKIE_SECURE === "true",
  trustProxy: process.env.TRUST_PROXY === "true",
  allowDemoReset: process.env.ALLOW_DEMO_RESET === "true",
  logRequests: process.env.LOG_REQUESTS === "true",
  afterSaleDays: Number(process.env.AFTER_SALE_DAYS ?? "7"),
  allowLegacyCommands: process.env.ALLOW_LEGACY_COMMANDS === "true",
});
const stopSupportWorker = startSupportWorker(sql);
const stopKnowledgeWorker = startKnowledgeWorker(sql);
const server = app.listen(
  Number(process.env.PORT ?? 3001),
  process.env.HOST ?? "127.0.0.1",
  () => console.log("ShopMate API ready"),
);
server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.keepAliveTimeout = 5000;
let backupInProgress: Promise<unknown> | undefined,
  lastBackupDay = "";
const backupTimer = setInterval(() => {
  const day = new Date().toISOString().slice(0, 10);
  if (process.env.BACKUP_DIR && !backupInProgress && day !== lastBackupDay) {
    backupInProgress = runAutomaticBackup(
      databasePath,
      join(
        process.env.BACKUP_DIR,
        `shopmate-daily-${day}-${Date.now()}.sqlite`,
      ),
      () => {
        lastBackupDay = day;
      },
    )
      .catch(() => {
        // The task already emitted a correlated, redacted failure event.
      })
      .finally(() => {
        backupInProgress = undefined;
      });
  }
}, 60000);
backupTimer.unref();
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  app.locals.draining = true;
  clearInterval(expiryTimer);
  clearInterval(backupTimer);
  const deadline = setTimeout(() => {
    server.closeAllConnections();
    cancelAutomaticBackup();
    process.exit(1);
  }, 15000);
  deadline.unref();
  server.close(async () => {
    await stopSupportWorker();
    await stopKnowledgeWorker();
    await backupInProgress;
    sql.close();
    rmSync(databasePath + ".running", { force: true });
    clearTimeout(deadline);
    process.exit(0);
  });
  server.closeIdleConnections();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
