import { readSnapshot } from "./api-snapshot";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import {
  openDatabase,
  readDatabase,
  writeDatabase,
} from "../../backend/src/database";
import { test, expect, TEST_USER_PASSWORD } from "./fixtures";

test.beforeEach(() => {
  test.skip(!!process.env.PLAYWRIGHT_BASE_URL, "体验回归仅使用隔离夹具");
});

async function login(page: Page) {
  const response = await page.request.post("/api/auth/login", {
    headers: { "X-ShopMate-Request": "1" },
    data: { role: "user", username: "lin", password: TEST_USER_PASSWORD },
  });
  expect(response.ok()).toBe(true);
}

test("游客选择规格和数量后，登录直接继续结算；配送说明以报价为准", async ({
  page,
}) => {
  await page.goto("/products/p01");
  await page.getByText("配送与收货", { exact: true }).click();
  await expect(
    page.getByText("配送费按收货省份和配送规则核算", { exact: false }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "深灰 / 标准版", exact: true })
    .click();
  await page.getByRole("spinbutton", { name: "购买数量" }).fill("3");
  await page.getByRole("button", { name: "立即购买", exact: true }).click();
  await expect(page).toHaveURL(/\/login\?redirect=/);
  const destination = new URL(page.url()).searchParams.get("redirect")!;
  expect(
    new URL(destination, "http://localhost").searchParams.get("skuId"),
  ).toBe("p01-s2");
  expect(
    new URL(destination, "http://localhost").searchParams.get("quantity"),
  ).toBe("3");
  await page.getByLabel("账号", { exact: true }).fill("lin");
  await page.getByLabel("密码", { exact: true }).fill(TEST_USER_PASSWORD);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/checkout\?/);
  await expect(page.locator(".order-item")).toContainText(
    "深灰 / 标准版 · 3 件",
  );
  await expect(
    page.getByRole("button", { name: "提交订单", exact: true }),
  ).toBeEnabled();
});

test("结算新增非默认地址后自动选中，报价和订单使用新地址", async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/checkout?productId=p05&skuId=p05-s1&quantity=1");
  const submit = page.getByRole("button", { name: "提交订单", exact: true });
  await expect(submit).toBeEnabled();
  await page.getByRole("button", { name: "添加地址", exact: true }).click();
  await expect(submit).toBeDisabled();
  await page.getByLabel("收货人", { exact: true }).fill("体验测试新地址");
  await page.getByLabel("联系电话", { exact: true }).fill("13800000009");
  await page.getByLabel("配送省份", { exact: true }).fill("浙江省");
  await page
    .getByLabel("省 / 市 / 区", { exact: true })
    .fill("浙江省 杭州市 西湖区");
  await page
    .getByLabel("详细地址", { exact: true })
    .fill("虚构体验路 9 号，请勿发货");
  await expect(page.getByLabel("设为默认收货地址")).not.toBeChecked();
  await page.getByRole("button", { name: "保存地址", exact: true }).click();
  const selected = page
    .locator(".checkout-address-row")
    .filter({ hasText: "体验测试新地址" });
  await expect(selected.getByRole("radio")).toBeChecked();
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page).toHaveURL(/\/orders\/[^/]+\/pay$/);
  const orderId = page.url().split("/").at(-2)!;
  const state = await readSnapshot(page.request, "user");
  expect(
    state.db.orders.find((order: { id: string }) => order.id === orderId)
      .address.name,
  ).toBe("体验测试新地址");
  expect(
    state.db.addresses.find((address: { id: string }) => address.id === "a1")
      .isDefault,
  ).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("订单跨页总数使用服务端总数，并随搜索条件更新", async ({ page }) => {
  const sql = openDatabase(resolve("../backend/.e2e/shopmate.sqlite"));
  try {
    sql.exec("BEGIN IMMEDIATE");
    const db = readDatabase(sql);
    const original = db.orders.find((order) => order.userId === "u1")!;
    db.orders = Array.from({ length: 13 }, (_, i) => ({
      ...structuredClone(original),
      id: `UXCOUNT${String(i).padStart(3, "0")}`,
      items: original.items.map((item) => ({ ...item, id: `ux-line-${i}` })),
      status: "cancelled" as const,
    }));
    db.revision++;
    writeDatabase(sql, db);
    sql.exec("COMMIT");
  } finally {
    sql.close();
  }
  await login(page);
  await page.goto("/orders");
  await expect(page.getByText("共 13 笔订单", { exact: true })).toBeVisible();
  await expect(page.locator(".order-block")).toHaveCount(10);
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page.locator(".order-block")).toHaveCount(3);
  await expect(page.getByText("共 13 笔订单", { exact: true })).toBeVisible();
  await page.getByLabel("订单号或商品名称").fill("UXCOUNT012");
  await page.getByRole("button", { name: "搜索订单", exact: true }).click();
  await expect(page.getByText("共 1 笔订单", { exact: true })).toBeVisible();
});

test("超长搜索链接规范化，两个搜索入口均限制长度且页面保持可用", async ({
  page,
}) => {
  const failed: string[] = [];
  page.on("response", (response) => {
    if (response.status() >= 400 && response.url().includes("/api/"))
      failed.push(response.url());
  });
  await page.goto(`/products?q=${encodeURIComponent("无".repeat(101))}`);
  await expect(
    page.getByRole("heading", {
      name: `搜索：${"无".repeat(100)}`,
      exact: true,
    }),
  ).toBeVisible();
  expect(new URL(page.url()).searchParams.get("q")).toHaveLength(100);
  await page.goto(`/products?q=${encodeURIComponent("无".repeat(101))}&q=耳机`);
  await expect(
    page.getByRole("heading", {
      name: `搜索：${"无".repeat(100)}`,
      exact: true,
    }),
  ).toBeVisible();
  expect(new URL(page.url()).searchParams.getAll("q")).toEqual([
    "无".repeat(100),
  ]);
  await page.goto(`/products?q=${encodeURIComponent("a".repeat(99) + "😀")}`);
  await expect(
    page.getByRole("heading", { name: `搜索：${"a".repeat(99)}`, exact: true }),
  ).toBeVisible();
  expect(new URL(page.url()).searchParams.get("q")).toBe("a".repeat(99));
  await expect(
    page.getByRole("textbox", { name: "搜索商品", exact: true }),
  ).toHaveAttribute("maxlength", "100");
  await expect(
    page.getByRole("textbox", { name: "搜索商品关键词", exact: true }),
  ).toHaveAttribute("maxlength", "100");
  await page
    .getByRole("textbox", { name: "搜索商品关键词", exact: true })
    .fill("耳机");
  await page
    .locator(".catalogue-search")
    .getByRole("button", { name: "搜索", exact: true })
    .click();
  await expect(page.locator(".product-grid")).toContainText(
    "静听 无线头戴耳机",
  );
  expect(failed).toEqual([]);
});
