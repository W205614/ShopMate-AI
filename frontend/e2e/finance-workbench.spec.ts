import { readSnapshot } from "./api-snapshot";
import type { Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
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
  return (await readSnapshot(page.request, "admin")).db;
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
  test.skip(!!process.env.PLAYWRIGHT_BASE_URL, "财务工作台仅使用隔离夹具");
  for (const role of ["admin", "user"])
    await page.request.post("/api/auth/login", {
      headers,
      data: {
        role,
        username: role === "admin" ? "admin" : "lin",
        password: role === "admin" ? TEST_ADMIN_PASSWORD : TEST_USER_PASSWORD,
      },
    });
});
test("四页流水的汇总与CSV覆盖全部筛选结果，排序和查询保留URL", async ({
  page,
}) => {
  test.setTimeout(90000);
  for (let i = 0; i < 31; i++)
    await action(
      page,
      "adjustStock",
      "p01",
      "p01-s1",
      1,
      100 + i,
      `财务批次 ${i}`,
      { requestId: `finance-${i}` },
    );
  await page.goto("/admin/finance?q=财务批次&type=purchase");
  const rows = page.locator(".el-table__body-wrapper tbody tr");
  await expect(rows).toHaveCount(10);
  await expect(
    page.locator(".admin-kpi").filter({ hasText: "补货时登记的总采购额" }),
  ).toContainText("¥35.65");
  await page.locator(".el-pager li").filter({ hasText: /^4$/ }).click();
  await expect(rows).toHaveCount(1);
  await expect(
    page.locator(".admin-kpi").filter({ hasText: "补货时登记的总采购额" }),
  ).toContainText("¥35.65");
  await page.reload();
  await expect(page).toHaveURL(/page=4/);
  await expect(rows).toHaveCount(1);
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出当前 CSV", exact: true }).click();
  const csv = await readFile((await (await downloadEvent).path())!, "utf8");
  expect(csv.charCodeAt(0)).toBe(0xfeff);
  for (let i = 0; i < 31; i++) expect(csv).toContain(`"财务批次 ${i}"`);
  expect(csv).not.toContain("初始演示订单收款");
  const header = page.getByRole("columnheader", { name: "金额" });
  await header.click();
  await expect(page).toHaveURL(/sort=asc/);
  await expect(page).not.toHaveURL(/page=4/);
  await expect(rows.first()).toContainText("¥1.00");
  await header.click();
  await expect(page).toHaveURL(/sort=desc/);
  await expect(rows.first()).toContainText("¥1.30");
  await page.goBack();
  await expect(header).toHaveClass(/ascending/);
  await expect(rows.first()).toContainText("¥1.00");
  await page.goForward();
  await expect(header).toHaveClass(/descending/);
  const ledger = (await state(page)).ledger.find(
    (l) => l.note === "财务批次 0",
  )!;
  await page
    .getByPlaceholder("流水号 / 关联编号 / 说明")
    .fill(ledger.inventoryMovementId!);
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("财务批次 0");
});
test("新采购精确定位单次库存变动，历史SKU及缺失关联明确说明", async ({
  page,
}) => {
  const first = await action(
    page,
    "adjustStock",
    "p01",
    "p01-s1",
    1,
    12345,
    "首笔独立采购",
    { requestId: "link-first" },
  );
  const second = await action(
    page,
    "adjustStock",
    "p01",
    "p01-s1",
    2,
    23456,
    "第二笔独立采购",
    { requestId: "link-second" },
  );
  fixture((db) => {
    db.ledger.unshift(
      {
        id: "legacy-purchase",
        type: "purchase",
        amount: 321,
        reference: "p01-s1",
        note: "历史SKU采购",
        createdAt: new Date().toISOString(),
      },
      {
        id: "missing-purchase",
        type: "purchase",
        amount: 123,
        reference: "p01-s1",
        inventoryMovementId: "missing-movement",
        note: "变动不可用",
        createdAt: new Date().toISOString(),
      },
    );
  });
  for (const [name, id] of [
    ["首笔独立采购", first.movementId],
    ["第二笔独立采购", second.movementId],
  ]) {
    await page.goto(`/admin/finance?q=${encodeURIComponent(name)}`);
    await page.getByRole("link", { name: "查看库存变动", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`detail=${id}`));
    await expect(
      page.getByRole("dialog", { name: "库存变动详情", exact: true }),
    ).toContainText(name);
  }
  await page.goto("/admin/finance?q=legacy-purchase");
  await expect(
    page.getByText("历史仅关联 SKU，无法定位单次变动", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "搜索该 SKU 相关记录", exact: true })
    .click();
  await expect(page).toHaveURL(/tab=records/);
  await expect(page).toHaveURL(/q=p01-s1/);
  await expect(page).not.toHaveURL(/detail=/);
  await page.goto("/admin/finance?detail=missing-purchase&q=no-result");
  const dialog = page.getByRole("dialog", { name: "流水详情", exact: true });
  await expect(dialog).toContainText("关联库存变动不可用");
  await expect(
    dialog.getByRole("link", { name: "查看库存变动", exact: true }),
  ).toHaveCount(0);
  await page.goto("/admin/finance?detail=missing-ledger");
  await expect(
    page.getByRole("alert").filter({ hasText: "没有找到该流水" }),
  ).toBeVisible();
});
test("同一订单多次部分退款查询守恒，详情跳转订单且金额不受分页影响", async ({
  page,
}) => {
  const quote = await action(page, "quoteCheckout", {
    source: { type: "buyNow", productId: "p01", skuId: "p01-s1", quantity: 3 },
    addressId: "a1",
  });
  const orderId = await action(page, "createOrder", {
    quoteId: quote.id,
    requestId: crypto.randomUUID(),
  });
  await action(page, "payOrder", orderId);
  for (let i = 0; i < 2; i++) {
    const order = (await state(page)).orders.find((o) => o.id === orderId)!;
    await action(
      page,
      "requestAfterSale",
      orderId,
      "财务分批退款",
      "核对两次部分退款",
      [{ orderItemId: order.items[0]!.id, quantity: 1 }],
    );
    const sale = (await state(page)).afterSales.find(
      (a) => a.orderId === orderId && a.status === "requested",
    )!;
    await action(page, "processAfterSale", sale.id, "approve", "同意退款");
    await action(page, "processAfterSale", sale.id, "refund", "完成退款");
  }
  await page.goto(`/admin/finance?q=${orderId}`);
  await expect(page.locator(".el-table__body-wrapper tbody tr")).toHaveCount(3);
  await expect(
    page.locator(".admin-kpi").filter({ hasText: "已完成的售后退款" }),
  ).toContainText("¥798.00");
  await expect(
    page.locator(".admin-kpi").filter({ hasText: "筛选范围净收支" }),
  ).toContainText("¥399.00");
  await page
    .getByRole("link", { name: "查看订单", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("dialog", { name: "订单详情", exact: true }),
  ).toContainText(orderId);
});
test("本地日期首尾、无效范围恢复及CSV特殊字符安全", async ({ page }) => {
  fixture((db) => {
    db.ledger.push(
      ...[
        ["local-before", "2026-10-16T15:59:59.999Z", "不在本地日"],
        ["local-start", "2026-10-16T16:00:00Z", ' =SUM(1,2)\n"行首"'],
        ["local-end", "2026-10-17T15:59:59.999Z", "本地日末尾"],
        ["local-after", "2026-10-17T16:00:00Z", "在下一本地日"],
      ].map(([id, createdAt, note]) => ({
        id: id!,
        type: "purchase" as const,
        amount: 1,
        reference: "date-fixture",
        note: note!,
        createdAt: createdAt!,
      })),
    );
  });
  await page.goto(
    "/admin/finance?q=date-fixture&from=2026-10-17&to=2026-10-17",
  );
  const rows = page.locator(".el-table__body-wrapper tbody tr");
  await expect(rows).toHaveCount(2);
  await expect(rows).toContainText(["本地日末尾", "=SUM(1,2)"]);
  const event = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出当前 CSV", exact: true }).click();
  const csv = await readFile((await (await event).path())!, "utf8");
  expect(csv).toContain('"\' =SUM(1,2)\n""行首"""');
  expect(csv).not.toContain("不在本地日");
  expect(csv).not.toContain("在下一本地日");
  await page.goto(
    "/admin/finance?q=date-fixture&from=2026-10-18&to=2026-10-17",
  );
  await expect(
    page.getByRole("alert").filter({ hasText: "开始日期不能晚于结束日期" }),
  ).toBeVisible();
  await expect(rows).toHaveCount(0);
  const total = (await state(page)).ledger.length;
  await page.getByRole("button", { name: "重置筛选", exact: true }).click();
  await expect(rows).toHaveCount(Math.min(total, 10));
});
test("合法单笔金额的大额汇总和CSV不丢失分币", async ({ page }) => {
  fixture((db) => {
    db.ledger = Array.from({ length: 3 }, (_, i) => ({
      id: `large-${i}`,
      type: "purchase",
      amount: Number.MAX_SAFE_INTEGER,
      reference: "large",
      note: "精确分币",
      createdAt: new Date().toISOString(),
    }));
  });
  await page.goto("/admin/finance?q=large");
  await expect(
    page.locator(".admin-kpi").filter({ hasText: "补货时登记的总采购额" }),
  ).toContainText("¥270,215,977,642,229.73");
  const event = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出当前 CSV", exact: true }).click();
  const csv = await readFile((await (await event).path())!, "utf8");
  expect(csv.match(/"90071992547409\.91"/g)).toHaveLength(3);
});
