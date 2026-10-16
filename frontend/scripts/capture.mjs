import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const destination = fileURLToPath(
  new URL("../../docs/screenshots/", import.meta.url),
);
await mkdir(destination, { recursive: true });
const browser = await chromium.launch({
  channel: process.platform === "win32" ? "msedge" : undefined,
});
const context = await browser.newContext({
  baseURL: process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:18086",
  reducedMotion: "reduce",
  timezoneId: "Asia/Shanghai",
  locale: "zh-CN",
  viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage();
async function capture(path, name, fullPage = true) {
  await page.goto(path);
  await page.locator("h1").first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500); // Finish Element Plus's initial tag transition before photographing it.
  await page.screenshot({ path: destination + name + ".png", fullPage });
}
await capture("/", "storefront-desktop");
await page.screenshot({ path: destination + "storefront-desktop-fold.jpg", quality: 85, fullPage: false });
await page.setViewportSize({ width: 768, height: 1024 });
await capture("/", "storefront-tablet");
await page.setViewportSize({ width: 390, height: 844 });
await capture("/", "storefront-mobile");
await page.setViewportSize({ width: 1440, height: 1000 });
await capture("/products/p01", "product");
await page.goto("/admin/login");
await page.getByLabel("账号", { exact: true }).fill("admin");
await page.getByLabel("密码", { exact: true }).fill("demo123");
await page.getByRole("button", { name: "登录", exact: true }).click();
await page.waitForURL("**/admin");
// Viewport capture avoids Edge's fixed-sidebar full-page repaint artifact.
await capture("/admin", "admin-desktop", false);
await capture("/admin/products", "admin-products", false);
await page.setViewportSize({ width: 390, height: 844 });
await capture("/admin", "admin-mobile");
await browser.close();
console.log(
  "Saved storefront / product / admin screenshots to docs/screenshots",
);
