import type { Page } from "@playwright/test";
import {
  openDatabase,
  readDatabase,
  writeDatabase,
} from "../../backend/src/database";
import { resolve } from "node:path";
import type { Database } from "../../shared/domain/types";
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
async function state(page: Page): Promise<Database> {
  return (await (await page.request.get("/api/state?role=admin")).json()).db;
}
function fixture(change: (db: Database) => void) {
  const sql = openDatabase(resolve("../backend/.e2e/shopmate.sqlite"));
  try {
    sql.exec("BEGIN IMMEDIATE");
    const db = readDatabase(sql);
    change(db);
    db.revision++;
    writeDatabase(sql, db);
    sql.exec("COMMIT");
  } finally {
    sql.close();
  }
}
test.beforeEach(async ({ page }) => {
  test.skip(!!process.env.PLAYWRIGHT_BASE_URL, "概览一致性仅使用隔离夹具");
  for (const role of ["admin", "user"])
    expect(
      (
        await page.request.post("/api/auth/login", {
          headers,
          data: {
            role,
            username: role === "admin" ? "admin" : "lin",
            password:
              role === "admin" ? TEST_ADMIN_PASSWORD : TEST_USER_PASSWORD,
          },
        })
      ).ok(),
    ).toBe(true);
});
test("零收款及恰好一分峰值不同，所有趋势坐标有限，大额累计保留分币", async ({
  page,
}) => {
  fixture((db) => {
    db.ledger = [];
  });
  await page.goto("/admin");
  await expect(page.locator(".admin-chart text")).toHaveText("峰值 ¥0.00");
  fixture((db) => {
    db.ledger.push({
      id: "one-cent",
      type: "payment",
      amount: 1,
      reference: "boundary",
      note: "一分边界",
      createdAt: new Date().toISOString(),
    });
  });
  await page.reload();
  await expect(page.locator(".admin-chart text")).toHaveText("峰值 ¥0.01");
  await expect(page.locator(".admin-chart")).toHaveAttribute(
    "aria-label",
    /¥0\.01/,
  );
  expect(
    await page
      .locator(".admin-chart circle")
      .evaluateAll((nodes) =>
        nodes.every((node) => Number.isFinite(Number(node.getAttribute("cy")))),
      ),
  ).toBe(true);
  fixture((db) => {
    db.ledger = Array.from({ length: 3 }, (_, i) => ({
      id: `large-${i}`,
      type: "payment",
      amount: Number.MAX_SAFE_INTEGER,
      reference: "boundary",
      note: "大额边界",
      createdAt: new Date().toISOString(),
    }));
  });
  await page.reload();
  await expect(
    page.locator(".admin-kpi").filter({ hasText: "累计模拟收款" }),
  ).toContainText("¥270,215,977,642,229.73");
  await expect(page.locator(".admin-chart text")).toHaveText(
    "峰值 ¥270,215,977,642,229.73",
  );
});
test("待办和低库存跳转携带对应条件，最近订单可精确定位且待付款不称实付", async ({
  page,
}) => {
  const before = await state(page),
    order = before.orders.find((o) => o.id === "SM000005")!;
  await action(
    page,
    "requestAfterSale",
    "SM000005",
    "不再需要",
    "概览待审核定位",
    [{ orderItemId: order.items[0]!.id, quantity: 1 }],
  );
  const chat = await action(page, "createConversation", {});
  await action(page, "transferConversation", chat);
  fixture((db) => {
    db.products[0]!.skus[0]!.stock = 0;
  });
  await page.goto("/admin");
  for (const [name, url] of [
    ["待发货订单", "/admin/orders?status=paid"],
    ["待审核售后", "/admin/after-sales?status=requested"],
    ["等待人工接入", "/admin/support?status=waiting"],
  ]) {
    const link = page.getByRole("link", { name: new RegExp(name) });
    await expect(link).toHaveAttribute("href", url!);
    await link.click();
    if (name === "等待人工接入") {
      await expect(page.locator(".admin-conversation")).toHaveCount(1);
      await expect(page.locator(".admin-conversation")).toContainText(
        "等待人工",
      );
    } else
      await expect(
        page.locator(".el-table__body-wrapper tbody tr"),
      ).toHaveCount(
        (await state(page))[
          name === "待发货订单" ? "orders" : "afterSales"
        ].filter(
          (r) => r.status === (name === "待发货订单" ? "paid" : "requested"),
        ).length,
      );
    await page.goto("/admin");
  }
  await expect(
    page.getByRole("link", { name: "前往补货 ↗", exact: true }),
  ).toHaveAttribute("href", "/admin/inventory?low=1");
  const lowRow = page
    .locator(".el-table__body-wrapper tbody tr")
    .filter({ hasText: before.products[0]!.name })
    .filter({ hasText: "0" });
  await lowRow.getByRole("link", { name: "核对并补货", exact: true }).click();
  await expect(page).toHaveURL(/tab=stock&q=p01-s1/);
  await expect(page.locator(".el-table__body-wrapper tbody tr")).toHaveCount(1);
  await action(page, "adjustStock", "p01", "p01-s1", 8, 0, "概览定位后补货");
  await page.reload();
  await expect(page.locator(".el-table__body-wrapper tbody tr")).toHaveCount(1);
  await expect(page.locator(".el-table__body-wrapper tbody tr")).toContainText(
    "8 件",
  );
  await page.goto("/admin");
  await expect(
    page.getByRole("columnheader", { name: "订单金额", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "SM000005", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "订单详情", exact: true }),
  ).toContainText("SM000005");
});
test("部分退款后累计收款不抵扣、退款单列，销量扣实际退款数量", async ({
  page,
}) => {
  fixture((db) => {
    db.orders = [];
    db.ledger = [];
    db.afterSales = [];
  });
  const quote = await action(page, "quoteCheckout", {
    source: { type: "buyNow", productId: "p01", skuId: "p01-s1", quantity: 3 },
    addressId: "a1",
  });
  const orderId = await action(page, "createOrder", {
    quoteId: quote.id,
    requestId: "dashboard-refund",
  });
  await action(page, "payOrder", orderId);
  const order = (await state(page)).orders[0]!;
  await action(page, "requestAfterSale", orderId, "不再需要", "概览部分退款", [
    { orderItemId: order.items[0]!.id, quantity: 1 },
  ]);
  const sale = (await state(page)).afterSales[0]!;
  await action(page, "processAfterSale", sale.id, "approve");
  await action(page, "processAfterSale", sale.id, "refund");
  await page.goto("/admin");
  await expect(
    page.locator(".admin-kpi").filter({ hasText: "累计模拟收款" }),
  ).toContainText("¥1,197.00");
  await expect(
    page.locator(".admin-kpi").filter({ hasText: "累计退款" }),
  ).toContainText("¥399.00");
  await expect(page.locator(".admin-rank")).toHaveCount(1);
  await expect(page.locator(".admin-rank")).toContainText("2 件");
  await expect(
    page.getByText("已支付件数，扣除实际退款数量", { exact: true }),
  ).toBeVisible();
  await action(page, "requestAfterSale", orderId, "不再需要", "概览剩余退款", [
    { orderItemId: order.items[0]!.id, quantity: 2 },
  ]);
  const next = (await state(page)).afterSales[0]!;
  await action(page, "processAfterSale", next.id, "approve");
  await action(page, "processAfterSale", next.id, "refund");
  await expect(
    page.getByText("暂无已支付且未退款的销量", { exact: true }),
  ).toBeVisible();
});
