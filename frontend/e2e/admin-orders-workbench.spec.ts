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
async function state(page: Page) {
  return (await (await page.request.get("/api/state?role=admin")).json()).db;
}
async function createOrder(page: Page, quantity = 1, addressId = "a1") {
  const quote = await action(page, "quoteCheckout", {
    source: { type: "buyNow", productId: "p05", skuId: "p05-s1", quantity },
    addressId,
  });
  return action(page, "createOrder", {
    quoteId: quote.id,
    requestId: crypto.randomUUID(),
  }) as Promise<string>;
}
test.beforeEach(async ({ page }) => {
  test.skip(!!process.env.PLAYWRIGHT_BASE_URL, "运营夹具仅使用隔离数据库");
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
test("同步缓慢时逐字输入不丢字符，多条件和页码校正不会互相覆盖", async ({
  page,
}) => {
  for (let i = 0; i < 12; i++) await createOrder(page);
  await page.goto("/admin/orders?page=2");
  const search = page.getByPlaceholder("订单号 / 商品 / 收件人");
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/state?role=admin", async (route) => {
    const response = await route.fetch();
    await held;
    await route.fulfill({ response });
  });
  try {
    await search.pressSequentially("SM000005", { delay: 30 });
    await expect(search).toHaveValue("SM000005");
    await page.getByLabel("下单开始日期", { exact: true }).fill("2020-01-01");
    await page.getByLabel("下单结束日期", { exact: true }).fill("2099-01-01");
    await expect(search).toHaveValue("SM000005");
  } finally {
    release();
  }
  await expect
    .poll(() => new URL(page.url()).searchParams.get("q"))
    .toBe("SM000005");
  await expect
    .poll(() => new URL(page.url()).searchParams.get("from"))
    .toBe("2020-01-01");
  await expect
    .poll(() => new URL(page.url()).searchParams.get("to"))
    .toBe("2099-01-01");
  await expect(page).not.toHaveURL(/page=2/);
  await expect(page.locator(".el-table__body-wrapper tbody tr")).toHaveCount(1);
});
test("订单四页数据支持收件人/商品/编号、状态和本地日期筛选，URL刷新及前进后退", async ({
  page,
}) => {
  test.setTimeout(90000);
  await action(page, "saveAddress", {
    name: "运营定位收件人",
    phone: "13800000000",
    region: "上海市",
    detail: "运营定位测试地址",
    isDefault: false,
  });
  const address = (await state(page)).addresses.find(
    (a: { name: string }) => a.name === "运营定位收件人",
  );
  const ids = [];
  for (let i = 0; i < 31; i++) ids.push(await createOrder(page, 1, address.id));
  await page.goto("/admin/orders?q=运营定位收件人&status=pending");
  const rows = page.locator(".el-table__body-wrapper tbody tr");
  await expect(rows).toHaveCount(10);
  await page.locator(".el-pager li").filter({ hasText: /^4$/ }).click();
  await expect(rows).toHaveCount(1);
  await expect(page).toHaveURL(/page=4/);
  await page.reload();
  await expect(rows).toHaveCount(1);
  await page.locator(".el-pager li").filter({ hasText: /^3$/ }).click();
  await expect(rows).toHaveCount(10);
  await page.goBack();
  await expect(page).toHaveURL(/page=4/);
  await expect(rows).toHaveCount(1);
  await page.goForward();
  await expect(page).toHaveURL(/page=3/);
  await page.locator(".el-pager li").filter({ hasText: /^4$/ }).click();
  const cancelledId = (
    await rows.first().locator("td").first().innerText()
  ).trim();
  await action(page, "cancelOrder", cancelledId);
  await expect(page).toHaveURL(/page=3/);
  await expect(rows).toHaveCount(10);
  const before = (await state(page)).orders;
  const search = page.getByPlaceholder("订单号 / 商品 / 收件人");
  const activeId = ids.find((id) => id !== cancelledId)!;
  await search.fill(activeId);
  await expect(rows).toHaveCount(1);
  await expect(page).not.toHaveURL(/page=3/);
  await expect(rows).toContainText(activeId);
  await search.fill("日常 陶瓷马克杯");
  await expect(rows).toHaveCount(10);
  await page.locator(".admin-toolbar .el-select").click();
  await page.getByRole("option", { name: "待发货", exact: true }).click();
  await expect(rows).toHaveCount(1);
  await page.locator(".admin-toolbar .el-select").click();
  await page.getByRole("option", { name: "待付款", exact: true }).click();
  const today = new Date().toLocaleDateString("sv-SE", {
    timeZone: "Asia/Shanghai",
  });
  await page.getByLabel("下单开始日期", { exact: true }).fill(today);
  await page.getByLabel("下单结束日期", { exact: true }).fill(today);
  await expect(rows).toHaveCount(10);
  const url = page.url();
  await page.reload();
  await expect(page).toHaveURL(url);
  await expect(page.getByLabel("下单开始日期", { exact: true })).toHaveValue(
    today,
  );
  await page.getByLabel("下单开始日期", { exact: true }).fill("2099-01-01");
  await expect(rows).toHaveCount(0);
  await expect(
    page.getByRole("alert").filter({ hasText: "开始日期不能晚于结束日期" }),
  ).toBeVisible();
  expect((await state(page)).orders).toEqual(before);
});
test("指定订单独立于列表筛选定位，展示部分退款数量和真实进度并发货余量", async ({
  page,
}) => {
  const id = await createOrder(page, 3);
  await action(page, "payOrder", id);
  let db = await state(page);
  const item = db.orders.find((o: { id: string }) => o.id === id).items[0];
  await action(page, "requestAfterSale", id, "不再需要", "部分商品退款测试", [
    { orderItemId: item.id, quantity: 1 },
  ]);
  db = await state(page);
  const saleId = db.afterSales[0].id;
  await action(page, "processAfterSale", saleId, "approve");
  await action(page, "processAfterSale", saleId, "refund");
  await page.goto(`/admin/orders?q=不存在的筛选&page=999&detail=${id}`);
  const detail = page.getByRole("dialog", { name: "订单详情", exact: true });
  await expect(detail).toContainText(id);
  await expect(detail).toContainText("购买 3 件 · 已退 1 件 · 未退 2 件");
  await expect(detail).toContainText("待发货数量：2 件");
  await expect(detail).toContainText("模拟付款成功");
  await expect(detail).toContainText("模拟退款完成");
  await page.reload();
  await expect(detail).toContainText(id);
  await detail
    .getByRole("button", { name: "填写发货信息", exact: true })
    .click();
  const shipping = page.getByRole("dialog", { name: "模拟发货", exact: true });
  await shipping.getByPlaceholder("输入演示物流单号").fill("ORDERWORKBENCH123");
  await shipping
    .getByRole("button", { name: "确认模拟发货", exact: true })
    .click();
  await expect(shipping).not.toBeVisible();
  await expect(detail).toContainText("待发货数量：0 件");
  await expect(detail).toContainText("已模拟发货");
  await detail.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page).not.toHaveURL(/detail=/);
  await page.goto("/admin/orders?detail=missing-order");
  await expect(
    page.getByRole("alert").filter({ hasText: "没有找到该订单" }),
  ).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "订单详情", exact: true }),
  ).not.toContainText(id);
});
