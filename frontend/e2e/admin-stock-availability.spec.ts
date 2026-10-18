import type { Page } from "@playwright/test";
import {
  test,
  expect,
  TEST_USER_PASSWORD,
  TEST_ADMIN_PASSWORD,
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

test("库存区分实物、待付款预占和可售，低库存预警及盘点基准一致", async ({
  page,
}) => {
  test.skip(!!process.env.PLAYWRIGHT_BASE_URL, "库存夹具仅使用隔离数据库");
  for (const role of ["admin", "user"]) {
    const response = await page.request.post("/api/auth/login", {
      headers,
      data: {
        role,
        username: role === "admin" ? "admin" : "lin",
        password: role === "admin" ? TEST_ADMIN_PASSWORD : TEST_USER_PASSWORD,
      },
    });
    expect(response.ok()).toBe(true);
  }
  const inventory = await (
    await page.request.get("/api/collections/products?role=admin&id=p05")
  ).json();
  const expectedStock = inventory.items[0].skus.find(
    (sku: { id: string }) => sku.id === "p05-s1",
  ).stock;
  await action(page, "adjustStock", "p05", "p05-s1", 10, 0, "可售库存夹具", {
    requestId: crypto.randomUUID(),
    mode: "count",
    expectedStock,
  });
  const quote = await action(page, "quoteCheckout", {
    source: { type: "buyNow", productId: "p05", skuId: "p05-s1", quantity: 8 },
    addressId: "a1",
  });
  const id = await action(page, "createOrder", {
    quoteId: quote.id,
    requestId: crypto.randomUUID(),
  });
  await page.goto("/admin/inventory?q=p05-s1&low=1");
  const row = page.locator(".el-table__body-wrapper tbody tr");
  await expect(row).toHaveCount(1);
  await expect(
    page.getByRole("columnheader", { name: "实物库存", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("columnheader", { name: "待付款预占", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("columnheader", { name: "可售库存" }),
  ).toBeVisible();
  await expect(row.locator("td").nth(2)).toContainText("10 件");
  await expect(row.locator("td").nth(3)).toContainText("8 件");
  await expect(row.locator("td").nth(4)).toContainText("2 件");
  await row.getByRole("button", { name: "补货 / 调整" }).click();
  const dialog = page.getByRole("dialog", { name: "调整库存", exact: true });
  await dialog.getByText("盘点实际库存", { exact: true }).click();
  await expect(
    dialog.getByRole("spinbutton", { name: "实盘数量", exact: true }),
  ).toHaveValue("10");
  await dialog
    .getByRole("spinbutton", { name: "实盘数量", exact: true })
    .fill("12");
  await dialog
    .getByPlaceholder("例如：到货入库 / 盘点修正")
    .fill("核对实物库存基准");
  await dialog.getByRole("button", { name: "确认调整", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(row.locator("td").nth(2)).toContainText("12 件");
  await expect(row.locator("td").nth(4)).toContainText("4 件");
  await page.goto("/admin");
  const warning = page.locator("section").filter({
    has: page.getByRole("heading", { name: "低库存提醒", exact: true }),
  });
  await expect(warning).toContainText("日常 陶瓷马克杯");
  await action(page, "cancelOrder", id);
  await page.goto("/admin/inventory?q=p05-s1&low=1");
  await expect(row).toHaveCount(0);
  await page.goto("/admin/inventory?q=p05-s1");
  await expect(row.locator("td").nth(2)).toContainText("12 件");
  await expect(row.locator("td").nth(3)).toContainText("0 件");
  await expect(row.locator("td").nth(4)).toContainText("12 件");
});
