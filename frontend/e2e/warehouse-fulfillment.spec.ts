import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import type { Warehouse, WarehouseStock } from "../../shared/domain/warehouses";
import { defaultWarehouseId } from "../../shared/domain/warehouses";
import type { CheckoutQuote } from "../../shared/domain/types";
import {
  expect,
  test,
  TEST_ADMIN_PASSWORD,
  TEST_USER_PASSWORD,
} from "./fixtures";

async function post(page: Page, path: string, data: unknown) {
  const response = await page.request.post(path, {
    headers: { "X-ShopMate-Request": "1" },
    data,
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function action<T = void>(
  page: Page,
  method: string,
  ...args: unknown[]
): Promise<T> {
  return (
    await post(page, `/api/actions/${method}`, {
      args,
      requestId: randomUUID(),
    })
  ).result;
}

test("结算展示跨仓包裹，管理员分别发货，顾客逐包确认收货", async ({ page }) => {
  test.skip(
    !!process.env.PLAYWRIGHT_BASE_URL &&
      process.env.E2E_MUTATIONS_ALLOWED !== "1",
    "本流程仅对隔离数据执行",
  );
  await post(page, "/api/auth/login", {
    role: "admin",
    username: "admin",
    password: TEST_ADMIN_PASSWORD,
  });
  const s = await page.request.get("/api/admin/warehouses");
  expect(s.ok()).toBe(true);
  const state = (await s.json()) as { stocks: WarehouseStock[] };
  const stock = state.stocks.find(
    (entry) =>
      entry.warehouseId === defaultWarehouseId && entry.skuId === "p01-s1",
  )!;
  const second = await action<Warehouse>(page, "saveWarehouse", {
    name: `隔离发货仓-${randomUUID().slice(0, 6)}`,
    priority: 10,
    provinces: [],
    acceptsOrders: true,
  });
  await action(page, "adjustStock", "p01", "p01-s1", 2, 0, "跨仓验收盘点", {
    requestId: randomUUID(),
    mode: "count",
    expectedStock: stock.onHand,
  });
  await action(page, "adjustStock", "p01", "p01-s1", 2, 0, "跨仓验收入库", {
    requestId: randomUUID(),
    warehouseId: second.id,
  });
  await page.goto("/admin/warehouses");
  await expect(page.getByRole("heading", { name: "多仓履约" })).toBeVisible();
  await expect(page.getByRole("button", { name: "新增仓库" })).toBeVisible();

  await post(page, "/api/auth/register", {
    username: `warehouse${randomUUID().replaceAll("-", "").slice(0, 10)}`,
    name: "多仓验收顾客",
    password: TEST_USER_PASSWORD,
  });
  await action(page, "saveAddress", {
    name: "多仓验收顾客",
    phone: "13800138000",
    province: "上海市",
    region: "上海市 浦东新区",
    detail: "隔离验收地址",
    isDefault: true,
  });
  await page.goto("/products/p01");
  await page.getByRole("spinbutton", { name: "购买数量" }).fill("4");
  const quoteResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/actions/quoteCheckout") && response.ok(),
  );
  await page.getByRole("button", { name: "立即购买", exact: true }).click();
  const quote = (await (await quoteResponse).json()).result as CheckoutQuote;
  expect(quote.allocations?.map((entry) => entry.quantity)).toEqual([2, 2]);
  await expect(
    page.getByText("商品预计由 2 个仓库分批发出", { exact: false }),
  ).toBeVisible();
  const orderId = await action<string>(page, "createOrder", {
    quoteId: quote.id,
    requestId: randomUUID(),
  });
  await action(page, "payOrder", orderId);
  await page.goto(`/admin/orders?detail=${orderId}`);
  for (const tracking of ["WAREHOUSE-SPLIT-01", "WAREHOUSE-SPLIT-02"]) {
    await page
      .getByRole("button", { name: "填写发货信息", exact: true })
      .click();
    const shipping = page.getByRole("dialog", { name: "模拟发货" });
    await shipping.getByPlaceholder("输入演示物流单号").fill(tracking);
    await shipping.getByRole("button", { name: "确认模拟发货" }).click();
    await expect(shipping).toBeHidden();
  }
  await page.goto(`/orders/${orderId}`);
  await expect(
    page.getByRole("heading", { name: "包裹 1 · 已发货" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "包裹 2 · 已发货" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "确认此包裹收货" }).first().click();
  await expect(
    page.getByRole("heading", { name: "包裹 1 · 已收货" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "包裹 2 · 已发货" }),
  ).toBeVisible();
});
