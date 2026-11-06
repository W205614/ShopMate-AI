import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
const port = process.env.PRODUCTION_BROWSER_PORT ?? "18763";
export default defineConfig({
  testDir: "./e2e",
  testMatch: "production-*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: "list",
  outputDir: "test-results-production",
  use: {
    baseURL: `https://127.0.0.1:${port}`,
    ignoreHTTPSErrors: true,
    browserName: "chromium",
    channel: process.platform === "win32" ? "msedge" : undefined,
    timezoneId: "Asia/Shanghai",
    locale: "zh-CN",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node --import tsx test/support/production-browser-server.ts",
    cwd: resolve("../backend"),
    url: `https://127.0.0.1:${port}/api/health`,
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    env: {
      PRODUCTION_BROWSER_ACCEPTANCE: "1",
      PRODUCTION_BROWSER_PORT: port,
      PRODUCTION_BROWSER_TOKEN:
        "shopmate-isolated-browser-fixture-control-token",
    },
    timeout: 60_000,
  },
});
