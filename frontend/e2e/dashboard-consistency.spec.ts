import { readSnapshot } from "./api-snapshot";
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
test("手机顾客按可买规格筛选并试算配送", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  fixture((db) => {
    const [cheap, available] = db.products[0]!.skus;
    Object.assign(cheap!, { price: 8_900, stock: 0 });
    Object.assign(available!, { price: 11_900, stock: 8 });
    db.addresses.push({
      ...db.addresses.find((address) => address.userId === "u1")!,
      id: "legacy-zhejiang-address",
      name: "浙江收件人",
      region: "浙江 杭州市 西湖区",
      province: "浙江",
      isDefault: false,
    });
    db.shippingRules!.push(
      {
        id: "region-delivery",
        name: "浙江配送",
        province: "浙江省",
        enabled: true,
        fee: 600,
        freeAbove: 23_800,
        version: 1,
      },
      {
        id: "region-block",
        name: "地区限制",
        province: "测试禁送区",
        enabled: false,
        fee: 0,
        freeAbove: 0,
        version: 1,
      },
    );
  });
  const product = (await state(page)).products[0]!;
  await page.goto(
    `/products?q=${encodeURIComponent(product.name)}&max=100&stock=1&sort=price-asc`,
  );
  await expect(page.locator(".catalogue-results .product-card")).toHaveCount(0);
  await page.getByLabel("最高价格").fill("119");
  await page.getByRole("button", { name: "应用价格" }).click();
  const card = page.locator(".catalogue-results .product-card");
  await expect(card).toContainText("¥119.00");
  await expect(card).toContainText(product.skus[1]!.name);
  await card.click();
  await expect(page).toHaveURL(new RegExp(`sku=${product.skus[1]!.id}`));
  await expect(
    page.getByRole("button", { name: product.skus[1]!.name, exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByText("配送与收货 · 试算运费", { exact: true }).click();
  const province = page.getByLabel("配送省份", { exact: true });
  const quote = page.getByRole("button", { name: "试算运费", exact: true });
  await province.fill("浙江");
  await quote.click();
  await expect(
    page.getByText(/预估运费 ¥6.00.*距包邮还差 ¥119.00/),
  ).toBeVisible();
  await page.getByRole("button", { name: "增加数量" }).click();
  await quote.click();
  await expect(page.getByText(/预估运费 ¥0.00.*浙江配送/)).toBeVisible();
  await province.fill("测试禁送区");
  await quote.click();
  await expect(
    page.getByText("该地区暂不配送。", { exact: true }),
  ).toBeVisible();
  await province.fill("浙江");
  await page.getByRole("button", { name: "减少数量" }).click();
  await page.getByRole("button", { name: "立即购买", exact: true }).click();
  await expect(page.getByText("选购时选择了 浙江省。")).toBeVisible();
  await expect(page.getByRole("radio", { name: /浙江收件人/ })).toBeChecked();
  await expect(page.locator(".summary-total")).toContainText("¥125.00");
  await page.getByRole("radio", { name: /默认收货地址/ }).check();
  await expect(
    page.getByText(/收货地址、运费有变化，应付由 ¥125.00 更新为 ¥119.00/),
  ).toBeVisible();
});
test("经营概览在没有业务写入时更新跨阈值的超时计数", async ({ page }) => {
  const conversationId = await action(page, "createConversation", {});
  await action(page, "transferConversation", conversationId);
  const threshold = Date.now() + 12_000;
  fixture((db) => {
    const conversation = db.conversations.find(
      (item) => item.id === conversationId,
    )!;
    conversation.waitingSince = new Date(threshold - 30 * 60_000).toISOString();
  });
  await page.clock.install();
  await page.goto("/admin");
  const queue = page.getByRole("link", { name: /等待人工接入/ });
  const soon = page.getByRole("link", { name: "即将超时 1", exact: true });
  await expect(soon).toBeVisible();
  await expect
    .poll(() => Date.now(), { timeout: 16_000 })
    .toBeGreaterThan(threshold);
  await page.clock.runFor(30_000);
  await expect(queue).toContainText("超时 1");
  await expect(soon).toHaveCount(0);
});

test("待办和低库存跳转携带对应条件，最近订单可精确定位且待付款不称实付", async ({
  page,
}) => {
  test.setTimeout(60_000);
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
    db.conversations.find((item) => item.id === chat)!.waitingSince = new Date(
      Date.now() - 31 * 60_000,
    ).toISOString();
  });
  await page.goto("/admin");
  for (const [name, url] of [
    ["待发货订单", "/admin/orders?status=paid&wait=all"],
    ["待审核售后", "/admin/after-sales?status=requested&wait=all"],
    ["等待人工接入", "/admin/support?status=waiting&wait=all"],
  ]) {
    const link = page.getByRole("link", { name: new RegExp(name) });
    await expect(link).toHaveAttribute("href", url!);
    if (name === "等待人工接入") await expect(link).toContainText("超时 1");
    await link.click();
    await expect(page.getByLabel("等待顺序")).toHaveValue("all");
    if (name === "等待人工接入") {
      await expect(page.locator(".admin-conversation")).toHaveCount(1);
      await expect(page.locator(".admin-conversation")).toContainText(
        "等待人工",
      );
      await page.getByLabel("等待顺序").selectOption("overdue");
      await expect(page.locator(".admin-conversation")).toHaveCount(1);
      await expect(page.locator(".admin-conversation")).toContainText("已等待");
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
  await page.goto("/admin/settings");
  const minutes = page.getByRole("spinbutton", {
    name: "等待人工接入（分钟）",
  });
  await minutes.fill("60");
  await minutes.press("Tab");
  await page.getByRole("button", { name: "保存信息", exact: true }).click();
  await expect(page.getByText("商城信息已保存", { exact: true })).toBeVisible();
  await page.goto("/admin");
  await page.getByRole("link", { name: "即将超时 1", exact: true }).click();
  await expect(page).toHaveURL(/support\?.*wait=soon/);
  await expect(page.locator(".admin-conversation")).toHaveCount(1);
  await page.goto("/admin");
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
