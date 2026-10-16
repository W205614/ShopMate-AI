import { test, expect, type Page } from "@playwright/test";

async function login(page: Page, admin = false) {
  await page.goto(admin ? "/admin/login" : "/login");
  await page.getByLabel("账号", { exact: true }).fill(admin ? "admin" : "lin");
  await page.getByLabel("密码", { exact: true }).fill("demo123");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(admin ? /\/admin$/ : /\/$/);
}

test("售后审核、模拟退款与用户状态和流水联动，刷新后保持", async ({
  page,
  context,
}) => {
  await login(page);
  await page.goto("/orders/SM000005");
  await page.getByRole("button", { name: "申请售后", exact: true }).click();
  await page.getByLabel("问题说明").fill("端到端验收：未发货演示退款");
  await page.getByRole("button", { name: "提交申请", exact: true }).click();
  await expect(
    page.getByText("待审核 · 不再需要", { exact: true }),
  ).toBeVisible();
  const management = await context.newPage();
  await login(management, true);
  await management.goto("/admin/after-sales");
  await management
    .getByRole("button", { name: "查看处理", exact: true })
    .click();
  const dialog = management.getByRole("dialog", {
    name: "售后处理",
    exact: true,
  });
  await dialog.getByRole("button", { name: "批准申请", exact: true }).click();
  await management
    .locator(".el-message-box")
    .getByRole("button", { name: "确定", exact: true })
    .click();
  await expect(dialog.getByText("已批准", { exact: true })).toBeVisible();
  await dialog
    .getByRole("button", { name: "执行模拟退款", exact: true })
    .click();
  await management
    .locator(".el-message-box")
    .getByRole("button", { name: "确定", exact: true })
    .click();
  await expect(dialog.getByText("已退款", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "已退款", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "已退款", exact: true }),
  ).toBeVisible();
  await page.goto("/orders/SM000005/pay");
  await expect(
    page.getByRole("heading", { name: "订单已退款", exact: true }),
  ).toBeVisible();
  await management.goto("/admin/finance");
  const row = management
    .locator(".el-table__body-wrapper tbody tr")
    .filter({ hasText: "模拟售后退款" });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("59.00");
});

test("全部页面可直达刷新、图片有效，商城不加载后台组件且移动端不溢出", async ({
  page,
}) => {
  const errors: string[] = [],
    assetFailures: string[] = [],
    requests: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (request) => requests.push(request.url()));
  page.on("response", (response) => {
    if (
      response.status() >= 400 &&
      /\.(jpg|woff2|js|css)(\?|$)/.test(response.url())
    )
      assetFailures.push(response.url());
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  expect(requests.some((url) => /element-plus|AdminLayout/.test(url))).toBe(
    false,
  );
  for (const path of [
    "/categories",
    "/products?q=杯",
    "/products/p01",
    "/credits",
    "/login",
    "/admin/login",
  ]) {
    await page.goto(path);
    await expect(page.locator("h1,h2").first()).toBeVisible();
    await page.reload();
    await expect(page.locator("h1,h2").first()).toBeVisible();
  }
  await login(page);
  for (const path of [
    "/cart",
    "/checkout",
    "/orders",
    "/orders/SM000001",
    "/orders/SM000005/pay",
    "/account",
    "/after-sales",
    "/support",
  ]) {
    await page.goto(path);
    await expect(page.locator("h1").first()).toBeVisible();
  }
  await login(page, true);
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
  ]) {
    await page.goto(path);
    await expect(page.locator("h1").first()).toBeVisible();
    await page.reload();
    await expect(page.locator("h1").first()).toBeVisible();
  }
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of [
      "/",
      "/products",
      "/products/p01",
      "/support",
      "/account",
      "/admin",
    ]) {
      await page.goto(path);
      await expect(page.locator("h1").first()).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth + 1,
        ),
        `页面溢出 ${path} @${width}`,
      ).toBe(true);
    }
  }
  expect(errors).toEqual([]);
  expect(assetFailures).toEqual([]);
});

test("损坏演示数据有恢复提示，管理员可以恢复而不白屏", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() =>
    localStorage.setItem(
      "shopmate-ai:database:v1",
      '{"version":1,"products":[null]}',
    ),
  );
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("演示数据损坏");
  await login(page, true);
  await page.goto("/admin/settings");
  await page.getByRole("button", { name: "恢复演示数据", exact: true }).click();
  const modal = page.locator(".el-message-box");
  await modal.locator("input").fill("恢复演示");
  await modal
    .getByRole("button", { name: "恢复初始数据", exact: true })
    .click();
  await expect(page.getByText("演示数据已恢复", { exact: true })).toBeVisible();
  await expect(page.locator(".storage-warning")).toHaveCount(0);
});
