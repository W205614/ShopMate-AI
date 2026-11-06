import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
export default defineConfig({
  testDir: "./e2e",
  testIgnore: "production-*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    timezoneId: "Asia/Shanghai",
    locale: "zh-CN",
    baseURL: process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:5173",
    browserName: "chromium",
    channel: process.platform === "win32" ? "msedge" : undefined,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : [
        {
          command: "node --import tsx src/index.ts",
          cwd: resolve("../backend"),
          url: "http://127.0.0.1:3001/api/health",
          reuseExistingServer: false,
          env: {
            SHOP_MODE: "demo",
            PAYMENT_CHANNELS: "",
            SMTP_HOST: "",
            SMS_ENABLED: "false",
            KUAIDI100_ENABLED: "false",
            BACKUP_S3_ENABLED: "false",
            LLM_API_KEY: "",
            EMBEDDING_API_KEY: "",
            RERANKER_API_KEY: "",
            DATABASE_PATH: resolve("../backend/.e2e/shopmate.sqlite"),
            ADMIN_PASSWORD: "TestAdmin123!",
            APP_ORIGINS: "http://127.0.0.1:5173",
            ALLOW_LEGACY_COMMANDS: "true",
            AI_ENABLED: "false",
            // The isolated pagination fixture creates 31 conversations in one test.
            SUPPORT_DAILY_CONVERSATIONS: "200",
          },
        },
        {
          command: "npm run dev -- --host 127.0.0.1",
          url: "http://127.0.0.1:5173",
          reuseExistingServer: !process.env.CI,
        },
      ],
});
