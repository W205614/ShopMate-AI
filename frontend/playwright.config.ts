import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
export default defineConfig({
  testDir: "./e2e",
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
          command: "npm --prefix ../backend start",
          url: "http://127.0.0.1:3001/api/health",
          reuseExistingServer: false,
          env: {
            DATABASE_PATH: resolve("../backend/.e2e/shopmate.sqlite"),
            ADMIN_PASSWORD: "TestAdmin123!",
            APP_ORIGINS: "http://127.0.0.1:5173",
          },
        },
        {
          command: "npm run dev -- --host 127.0.0.1",
          url: "http://127.0.0.1:5173",
          reuseExistingServer: !process.env.CI,
        },
      ],
});
