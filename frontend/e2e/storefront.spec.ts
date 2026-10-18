import type { Page } from "@playwright/test";
import { test, expect, TEST_USER_PASSWORD } from "./fixtures";

async function login(page: Page, username = "lin", redirect = "/products/p01") {
  await page.goto(`/login?redirect=${encodeURIComponent(redirect)}`);
  await page.getByLabel("账号", { exact: true }).fill(username);
  await page.getByLabel("密码", { exact: true }).fill(TEST_USER_PASSWORD);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(
    new RegExp(redirect.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$"),
  );
}

test("购物、模拟付款和刷新后的订单信息形成闭环", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await login(page);
  await expect(
    page.getByRole("heading", { name: "静听 无线头戴耳机", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "加入购物车", exact: false }).click();
  await expect(page.getByRole("status")).toContainText("已加入购物车");
  await page.goto("/cart");
  await expect(
    page.getByRole("heading", { name: "购物车", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("¥399.00", { exact: true }).last()).toBeVisible();
  await page.getByRole("link", { name: "去结算", exact: false }).click();
  await expect(
    page.getByRole("heading", { name: "确认订单", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "提交订单", exact: true }).click();
  await expect(page).toHaveURL(/\/orders\/[^/]+\/pay$/);
  await expect(page.getByText("不会扣款", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "确认模拟支付", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "模拟支付成功", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "查看订单", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "待发货", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("林小满（演示）", { exact: false }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "待发货", exact: true }),
  ).toBeVisible();
  await page.goto("/cart");
  await expect(
    page.getByRole("heading", { name: "还没有想带走的好物", exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("切换账号后隔离订单、地址和商品收藏", async ({ page }) => {
  await login(page, "lin", "/account");
  await expect(
    page.getByRole("heading", { name: "林小满，你好。", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".product-card")).toHaveCount(2);
  await page.getByRole("button", { name: "收货地址", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "林小满（演示）", exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await login(page, "chen", "/account");
  await expect(
    page.getByRole("heading", { name: "陈一禾，你好。", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".product-card")).toHaveCount(1);
  await page.getByRole("button", { name: "收货地址", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "陈一禾（演示）", exact: false }),
  ).toBeVisible();
  await expect(page.getByText("林小满（演示）", { exact: false })).toHaveCount(
    0,
  );
  await page.goto("/orders/SM000001");
  await expect(
    page.getByRole("heading", { name: "没有找到该订单", exact: true }),
  ).toBeVisible();
});

test("关键词筛选、缺货状态与购物车登录回跳", async ({ page }) => {
  await page.goto("/products/p01");
  const related = page.locator(".related-products");
  await expect(related).toBeVisible();
  await expect(related.locator(".product-card")).toHaveCount(3);
  await expect(related.locator('a[href="/products/p02"]')).toBeVisible();
  await page.goto("/products?q=不会存在的演示商品");
  await expect(
    page.getByRole("heading", { name: "换个关键词试试", exact: true }),
  ).toBeVisible();
  await page.goto("/products/p22");
  await expect(
    page.getByRole("button", { name: "加入购物车", exact: false }),
  ).toBeDisabled();
  await page.goto("/products/p24");
  await expect(page.getByText("此商品已下架，暂时无法购买。")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "加入购物车", exact: false }),
  ).toBeDisabled();
  await page.goto("/cart");
  await expect(page).toHaveURL(/\/login\?redirect=\/cart/);
  await page.getByLabel("账号", { exact: true }).fill("lin");
  await page.getByLabel("密码", { exact: true }).fill(TEST_USER_PASSWORD);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/cart$/);
});

test("手机目录无横向溢出且商品图片来自本地", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /好物与答案.*一起找到/ }),
  ).toBeVisible();
  const images = page.locator(".sheet-frame img");
  await expect(images).toHaveCount(23);
  await expect(images.first()).toHaveJSProperty("complete", true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "切换导航菜单" }).click();
  await expect(
    page.locator(".mobile-nav").getByRole("link", { name: "按类挑选" }),
  ).toBeVisible();
});
