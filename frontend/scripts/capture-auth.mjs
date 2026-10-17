import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const destination = fileURLToPath(new URL("../../docs/screenshots/", import.meta.url));
await mkdir(destination, { recursive: true });
const browser = await chromium.launch({channel: process.platform === "win32" ? "msedge" : undefined});
try {
  const page = await browser.newPage({
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:18086",
    viewport: {width: 1440, height: 900}, reducedMotion: "reduce", locale: "zh-CN",
  });
  for (const [path, name, width, height] of [
    ["/login", "login-desktop", 1440, 900],
    ["/admin/login", "admin-login-desktop", 1440, 900],
    ["/register", "register-mobile", 390, 844],
  ]) {
    await page.setViewportSize({width, height});
    await page.goto(path);
    await page.locator(".auth-submit").waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({path: `${destination}${name}.png`, fullPage: true});
  }
} finally { await browser.close(); }
