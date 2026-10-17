import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const phase = process.argv[2] || "after";
if (!["before", "after"].includes(phase))
  throw new Error("Use before or after");
const destination = fileURLToPath(
  new URL(`../../.taste-skill/page-audit/${phase}/`, import.meta.url),
);
await mkdir(destination, { recursive: true });
const browser = await chromium.launch({
  channel: process.platform === "win32" ? "msedge" : undefined,
});
const context = await browser.newContext({
  baseURL: process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:18086",
  locale: "zh-CN",
  timezoneId: "Asia/Shanghai",
  reducedMotion: "reduce",
});
if (!process.env.ADMIN_PASSWORD || !process.env.USER_USERNAME || !process.env.USER_PASSWORD) throw new Error("Set ADMIN_PASSWORD, USER_USERNAME and USER_PASSWORD for authenticated UI audit");
const page = await context.newPage();
const metrics = [];
async function photo(name, width) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      [...document.images]
        .filter((img) => img.getBoundingClientRect().top < window.innerHeight)
        .map((img) => img.decode().catch(() => {})),
    );
  });
  await page.waitForTimeout(150);
  await page.screenshot({
    path: `${destination}${width}-${name}.jpg`,
    quality: 75,
  });
  metrics.push(
    await page.evaluate(
      ({ name, width }) => ({
        name,
        width,
        height: document.documentElement.scrollHeight,
        overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
        headings: [...document.querySelectorAll("h1,h2")]
          .filter((el) => el.getBoundingClientRect().width)
          .map((el) => ({
            text: el.textContent.trim(),
            size: window.getComputedStyle(el).fontSize,
            top: Math.round(el.getBoundingClientRect().top),
            height: Math.round(el.getBoundingClientRect().height),
          })),
      }),
      { name, width },
    ),
  );
}
async function visit(path, name, width) {
  await page.goto(path);
  await page.locator("h1,h2").first().waitFor();
  await photo(name, width);
}
async function login(admin = false) {
  await page.goto(admin ? "/admin/login" : "/login");
  await page.getByLabel("账号", { exact: true }).fill(admin ? (process.env.ADMIN_USERNAME || "admin") : process.env.USER_USERNAME);
  await page.getByLabel("密码", { exact: true }).fill(admin ? process.env.ADMIN_PASSWORD : process.env.USER_PASSWORD);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.waitForURL(admin ? "**/admin" : (url) => url.pathname === "/");
}
try {
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await visit("/login", "login", width);
    await visit("/admin/login", "admin-login", width);
    for (const path of [
      "/",
      "/categories",
      "/products",
      "/products/p01",
      "/products?q=不会存在的商品",
      "/credits",
      "/missing-page",
      "/forbidden",
    ])
      await visit(
        path,
        path === "/"
          ? "home"
          : path
              .replace(/^\//, "")
              .replaceAll(/[^a-z0-9-]/g, "_")
              .replace(/_q_.*/, "-empty"),
        width,
      );
    await login();
    await page.goto("/products/p01");
    await page
      .getByRole("button", { name: "加入购物车", exact: false })
      .click();
    await page.getByRole("status").waitFor();
    for (const path of [
      "/cart",
      "/checkout",
      "/orders",
      "/orders/SM000005",
      "/orders/SM000005/pay",
      "/account",
      "/after-sales",
      "/support",
    ])
      await visit(path, path.slice(1).replaceAll("/", "-"), width);
    await page.goto("/account");
    await page.getByRole("button", { name: "收货地址", exact: true }).click();
    await photo("account-addresses", width);
    await login(true);
    for (const path of [
      "/admin",
      "/admin/products",
      "/admin/categories",
      "/admin/inventory",
      "/admin/orders",
      "/admin/after-sales",
      "/admin/finance",
      "/admin/support",
      "/admin/knowledge",
      "/admin/settings",
    ])
      await visit(path, path.slice(1).replaceAll("/", "-"), width);
    await page.goto("/admin/products");
    await page.getByRole("button", { name: "新建商品", exact: true }).click();
    await page.getByRole("dialog").waitFor();
    await photo("admin-product-dialog", width);
    await page
      .getByRole("button", { name: "保存商品", exact: true })
      .scrollIntoViewIfNeeded();
    await photo("admin-product-skus", width);
    await page.goto("/admin/finance");
    await page.getByPlaceholder("开始日期").click();
    await page.locator(".admin-date-range").waitFor();
    await photo("admin-finance-picker", width);
    await login();
    await page.goto("/checkout");
    await page.getByRole("button", { name: "提交订单", exact: true }).click();
    await page.waitForURL(/\/orders\/[^/]+\/pay$/);
    await photo("payment-pending", width);
    await page.goto("/account");
    await page.getByRole("button", { name: "收货地址", exact: true }).click();
    await page.getByRole("button", { name: "添加地址", exact: true }).click();
    await page
      .getByRole("heading", { name: "添加收货地址", exact: true })
      .evaluate((el) => el.scrollIntoView({ block: "start" }));
    await photo("account-address-form", width);
    await page.goto("/orders/SM000005");
    await page.getByRole("button", { name: "申请售后", exact: true }).click();
    await page
      .getByRole("heading", { name: "申请售后", exact: true })
      .evaluate((el) => el.scrollIntoView({ block: "start" }));
    await photo("after-sale-form", width);
    await page.goto("/support?productId=p01");
    await page.getByLabel("输入咨询内容").fill("配送需要多久？");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await page.getByRole("button", { name: "转人工", exact: true }).click();
    await photo("support-conversation", width);
    await page.goto("/admin/support");
    await page.locator(".admin-conversation").first().click();
    await photo("admin-support-conversation", width);
    // Separate identities and reset audit data without touching the user's browser profile.
    await page.goto("/");
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
    console.log(`${phase}: ${width}px complete`);
  }
  await writeFile(
    `${destination}metrics.json`,
    JSON.stringify(metrics, null, 2),
  );
  console.log(
    JSON.stringify({
      phase,
      screenshots: metrics.length,
      overflow: metrics
        .filter((x) => x.overflow)
        .map((x) => `${x.name}@${x.width}`),
    }),
  );
} finally {
  await browser.close();
}
