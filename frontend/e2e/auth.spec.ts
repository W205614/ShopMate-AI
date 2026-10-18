import type { Page } from "@playwright/test";
import { test, expect, TEST_ADMIN_PASSWORD } from "./fixtures";

const password = "UserSecure123!";
const unique = () =>
  `member_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
async function register(
  page: Page,
  username = unique(),
  redirect = "/account",
) {
  await page.goto(`/register?redirect=${encodeURIComponent(redirect)}`);
  await page.getByLabel("账号", { exact: true }).fill(username);
  await page.getByLabel("昵称", { exact: true }).fill("注册用户");
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByLabel("确认密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "注册并登录", exact: true }).click();
  return username;
}
test("注册、刷新、退出、错误密码和重新登录", async ({ page, context }) => {
  await page.goto("/account");
  await expect(page).toHaveURL(/\/login\?redirect=\/account/);
  await page.getByRole("link", { name: "还没有账号？立即注册" }).click();
  const username = await register(page);
  await expect(
    page.getByRole("heading", { name: "注册用户，你好。" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "注册用户，你好。" }),
  ).toBeVisible();
  const cookie = (await context.cookies()).find(
    (c) => c.name === "shopmate_user",
  )!;
  expect(cookie.httpOnly).toBe(true);
  expect(cookie.sameSite).toBe("Strict");
  expect(await page.evaluate(() => document.cookie)).not.toContain(
    "shopmate_user",
  );
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await page.goto("/account");
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel("账号", { exact: true }).fill(username);
  await page.getByLabel("密码", { exact: true }).fill("WrongPassword123");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("账号或密码错误");
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/account$/);
});
test("注册校验和重复账号提示，管理员不开放注册", async ({ page }) => {
  const username = unique();
  await page.goto("/register");
  await page.getByLabel("账号", { exact: true }).fill(username);
  await page.getByLabel("昵称", { exact: true }).fill("校验用户");
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByLabel("确认密码", { exact: true }).fill("Different123");
  await page.getByRole("button", { name: "注册并登录" }).click();
  await expect(page.getByRole("alert")).toContainText("两次输入的密码不一致");
  await page.getByLabel("确认密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "注册并登录" }).click();
  await expect(page).toHaveURL(/\/$/);
  await register(page, username);
  await expect(page.getByRole("alert")).toContainText("该账号已被注册");
  await page.goto("/admin/login");
  await expect(page.getByRole("link", { name: /注册/ })).toHaveCount(0);
  await page.getByLabel("账号", { exact: true }).fill(username);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("账号或密码错误");
});
test("新用户添加地址、下单和模拟付款，管理端可看到真实账号订单", async ({
  page,
  context,
}) => {
  await register(page);
  await expect(page).toHaveURL(/\/account$/);
  await page.getByRole("button", { name: "收货地址", exact: true }).click();
  await page.getByRole("button", { name: "添加地址", exact: true }).click();
  await page.getByLabel("收货人", { exact: true }).fill("新用户收货人");
  await page.getByLabel("联系电话", { exact: true }).fill("13800000001");
  await page.getByLabel("配送省份", { exact: true }).fill("上海市");
  await page.getByLabel("配送省份", { exact: true }).fill("上海市");
  await page.getByLabel("省 / 市 / 区", { exact: true }).fill("上海市 徐汇区");
  await page.getByLabel("详细地址", { exact: true }).fill("测试路 100 号");
  await page.getByRole("button", { name: "保存地址", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("收货地址已保存");
  await page.goto("/products/p01");
  await page.getByRole("button", { name: "加入购物车", exact: false }).click();
  await expect(page.getByRole("status")).toContainText("已加入购物车");
  await page.goto("/cart");
  await page.getByRole("link", { name: "去结算", exact: false }).click();
  await page.getByRole("button", { name: "提交订单", exact: true }).click();
  await expect(page).toHaveURL(/\/orders\/[^/]+\/pay$/);
  await page.getByRole("button", { name: "确认模拟支付", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "模拟支付成功", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "查看订单", exact: true }).click();
  await expect(page).toHaveURL(/\/orders\/[^/]+$/);
  const orderId = new URL(page.url()).pathname.split("/").pop()!;
  const management = await context.newPage();
  await management.goto("/admin/login?redirect=/admin/orders");
  await management.getByLabel("账号", { exact: true }).fill("admin");
  await management
    .getByLabel("密码", { exact: true })
    .fill(TEST_ADMIN_PASSWORD);
  await management.getByRole("button", { name: "登录", exact: true }).click();
  await expect(management).toHaveURL(/\/admin\/orders$/);
  await expect(
    management
      .locator(".el-table__body-wrapper tbody tr")
      .filter({ hasText: orderId }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "待发货", exact: true }),
  ).toBeVisible();
});
test("手机注册页无横向溢出，外部回跳地址被丢弃", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await register(page, unique(), "//evil.example");
  await expect(page).toHaveURL(/\/$/);
  await page.goto("/register");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
