import { readSnapshot } from "./api-snapshot";
import type { Page } from "@playwright/test";
import {
  test,
  expect,
  TEST_ADMIN_PASSWORD,
  TEST_USER_PASSWORD,
} from "./fixtures";
const headers = { "X-ShopMate-Request": "1" };
async function action(page: Page, method: string, ...args: unknown[]) {
  const response = await page.request.post(`/api/actions/${method}`, {
    headers,
    data: { args },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).result;
}
async function setup(page: Page, quantity = 5) {
  for (const role of ["admin", "user"]) {
    await page.request.post("/api/auth/login", {
      headers,
      data: {
        role,
        username: role === "admin" ? "admin" : "lin",
        password: role === "admin" ? TEST_ADMIN_PASSWORD : TEST_USER_PASSWORD,
      },
    });
  }
  const db = (await readSnapshot(page.request, "admin")).db;
  const ids = db.carts
    .filter((c: { userId: string }) => c.userId === "u1")
    .map((c: { id: string }) => c.id);
  if (ids.length) await action(page, "batchCart", { action: "remove", ids });
  await action(page, "addCart", "p01", "p01-s1", quantity);
  return db.products.find((p: { id: string }) => p.id === "p01").skus[0]
    .stock as number;
}
test.beforeEach(() =>
  test.skip(!!process.env.PLAYWRIGHT_BASE_URL, "库存变更仅使用隔离夹具"),
);
test("后台降库存后可调整至可购数量，零库存保留，补货后直接编辑恢复结算", async ({
  page,
}) => {
  const stock = await setup(page);
  await action(
    page,
    "adjustStock",
    "p01",
    "p01-s1",
    2 - stock,
    0,
    "库存下降测试",
  );
  await page.goto("/cart");
  const row = page.locator(".cart-row").first();
  await expect(
    row.getByText("库存不足，仅剩 2 件", { exact: true }),
  ).toBeVisible();
  await row
    .getByRole("button", { name: "调整至可购数量（2 件）", exact: true })
    .click();
  const input = row.getByRole("spinbutton");
  await expect(input).toHaveValue("2");
  await expect(page.getByRole("link", { name: "去结算" })).toBeVisible();
  await action(page, "adjustStock", "p01", "p01-s1", -2, 0, "库存售罄测试");
  await page.reload();
  await expect(
    row.getByText("暂时缺货，已为你保留购物车条目", { exact: true }),
  ).toBeVisible();
  await expect(input).toHaveValue("2");
  await expect(input).toBeDisabled();
  await expect(row.getByRole("button", { name: "减少数量" })).toBeDisabled();
  await page.getByRole("button", { name: "清理失效商品", exact: true }).click();
  await expect(row).toBeVisible();
  await action(page, "adjustStock", "p01", "p01-s1", 4, 0, "恢复库存测试");
  await page.reload();
  await input.fill("3");
  await input.press("Tab");
  await expect(input).toHaveValue("3");
  await expect(page.locator(".summary-total")).toContainText("¥1,197.00");
  await page.getByRole("link", { name: "去结算" }).click();
  await expect(
    page.getByRole("button", { name: "提交订单", exact: true }),
  ).toBeEnabled();
});
test("超量购物车减量直接落到库存上限，非法数量不提交并恢复已保存值", async ({
  page,
}) => {
  const stock = await setup(page);
  await action(
    page,
    "adjustStock",
    "p01",
    "p01-s1",
    2 - stock,
    0,
    "库存下降测试",
  );
  await page.goto("/cart");
  const row = page.locator(".cart-row").first();
  await row.getByRole("button", { name: "减少数量" }).click();
  const input = row.getByRole("spinbutton");
  await expect(input).toHaveValue("2");
  let writes = 0;
  await page.route("**/api/actions/updateCart", async (route) => {
    writes++;
    await route.continue();
  });
  for (const value of ["0", "1.5", "3"]) {
    await input.fill(value);
    await input.press("Tab");
    await expect(
      page.getByRole("alert").filter({ hasText: "数量须为 1 至 2 的整数" }),
    ).toBeVisible();
    await expect(input).toHaveValue("2");
  }
  expect(writes).toBe(0);
});
