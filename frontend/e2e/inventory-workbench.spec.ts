import { readSnapshot } from "./api-snapshot";
import type { Page } from "@playwright/test";
import { test, expect, TEST_ADMIN_PASSWORD } from "./fixtures";
const headers = { "X-ShopMate-Request": "1" };
async function action(page: Page, ...args: unknown[]) {
  const response = await page.request.post("/api/actions/adjustStock", {
    headers,
    data: { args },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).result;
}
async function state(page: Page) {
  return (await readSnapshot(page.request, "admin")).db;
}
test.beforeEach(async ({ page }) => {
  test.skip(!!process.env.PLAYWRIGHT_BASE_URL, "库存工作台仅使用隔离夹具");
  await page.request.post("/api/auth/login", {
    headers,
    data: { role: "admin", username: "admin", password: TEST_ADMIN_PASSWORD },
  });
});
test("实盘冻结基线，冲突保留目标和说明，加载最新后重新确认且不产生采购", async ({
  page,
}) => {
  await page.goto("/admin/inventory?q=p01-s1");
  const row = page.locator(".el-table__body-wrapper tbody tr").first();
  await row.getByRole("button", { name: "补货 / 调整" }).click();
  const dialog = page.getByRole("dialog", { name: "调整库存", exact: true });
  await dialog.getByText("盘点实际库存", { exact: true }).click();
  await expect(
    dialog.getByRole("radio", { name: "盘点实际库存", exact: true }),
  ).toBeChecked();
  await dialog.getByLabel("实盘数量", { exact: true }).fill("2");
  await dialog
    .getByPlaceholder("例如：到货入库 / 盘点修正")
    .fill("现场实盘两件");
  const before = await state(page);
  await action(page, "p01", "p01-s1", -1, 0, "另一管理页调整", {
    requestId: "external-delta",
  });
  await dialog.getByRole("button", { name: "确认调整", exact: true }).click();
  await expect(
    page.getByText("库存已变化，请加载最新库存，重新核对实盘数量后提交", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(dialog.getByLabel("实盘数量", { exact: true })).toHaveValue("2");
  await expect(
    dialog.getByPlaceholder("例如：到货入库 / 盘点修正"),
  ).toHaveValue("现场实盘两件");
  await dialog
    .getByRole("button", { name: "加载最新库存", exact: true })
    .click();
  await dialog.getByRole("button", { name: "确认调整", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const after = await state(page);
  expect(after.products[0].skus[0].stock).toBe(2);
  expect(after.ledger).toEqual(before.ledger);
  expect(after.inventory[0]).toMatchObject({
    beforeStock: before.products[0].skus[0].stock - 1,
    afterStock: 2,
    mode: "count",
    reason: "现场实盘两件",
  });
});
for (const fault of ["响应丢失", "结果结构损坏"])
  test(`补货${fault}后刷新恢复原请求，重复提交不重复入库或支出`, async ({
    page,
  }) => {
    await page.goto("/admin/inventory?q=p01-s1");
    await page.getByRole("button", { name: "补货 / 调整" }).click();
    const dialog = page.getByRole("dialog", { name: "调整库存", exact: true });
    await dialog
      .getByLabel("调整数量（正数补货，负数盘亏）", { exact: true })
      .fill("3");
    await dialog
      .getByLabel("本次采购总支出（元，0 表示无采购成本）", { exact: true })
      .fill("123.45");
    await dialog
      .getByPlaceholder("例如：到货入库 / 盘点修正")
      .fill("响应丢失补货");
    const before = await state(page);
    const requests: unknown[][] = [];
    // Hold read-only recovery until the unknown-result UI has been observed.
    // A fast background lookup must not skip the state this scenario exercises.
    let allowRecovery = false;
    await page.route(
      "**/api/requests/*?method=adjustStock&role=admin",
      (route) =>
        allowRecovery
          ? route.continue()
          : route.fulfill({ json: { found: false } }),
    );
    await page.route("**/api/actions/adjustStock", async (route) => {
      requests.push(route.request().postDataJSON().args);
      await route.fetch();
      if (fault === "响应丢失") await route.abort("failed");
      else
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            result: {
              movementId: "broken",
              beforeStock: 1,
              afterStock: 5,
              delta: 3,
            },
          }),
        });
    });
    await dialog.getByRole("button", { name: "确认调整", exact: true }).click();
    await expect(dialog).toContainText("结果未知");
    await expect(
      dialog.getByLabel("调整数量（正数补货，负数盘亏）", { exact: true }),
    ).toBeDisabled();
    allowRecovery = true;
    await page.reload();
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("该请求已完成");
    await dialog
      .getByRole("button", { name: "确认已完成并关闭", exact: true })
      .click();
    await expect(dialog).not.toBeVisible();
    expect(requests).toHaveLength(1);
    const result = await action(page, ...requests[0]!);
    const after = await state(page);
    expect(result).toMatchObject({
      beforeStock: before.products[0].skus[0].stock,
      afterStock: before.products[0].skus[0].stock + 3,
    });
    expect(after.inventory).toHaveLength(before.inventory.length + 1);
    expect(after.ledger).toHaveLength(before.ledger.length + 1);
    expect(after.ledger[0].amount).toBe(12345);
  });
test("库存与变动四页分页、检索、刷新及指定变动定位", async ({ page }) => {
  test.setTimeout(90000);
  let latest = "";
  for (let i = 0; i < 31; i++)
    latest = (
      await action(page, "p01", "p01-s1", 1, 0, `盘查批次 ${i}`, {
        requestId: `batch-${i}`,
      })
    ).movementId;
  await page.goto("/admin/inventory?tab=records&q=盘查批次");
  const rows = page.locator(".el-table__body-wrapper tbody tr");
  await expect(rows).toHaveCount(10);
  await page.locator(".el-pager li").filter({ hasText: /^4$/ }).click();
  await expect(rows).toHaveCount(1);
  await page.reload();
  await expect(page).toHaveURL(/page=4/);
  await expect(rows).toHaveCount(1);
  await page.goBack();
  await expect(rows).toHaveCount(10);
  await page.goForward();
  await expect(rows).toHaveCount(1);
  await page.goto(`/admin/inventory?tab=records&detail=${latest}`);
  await expect(
    page.getByRole("dialog", { name: "库存变动详情", exact: true }),
  ).toContainText("盘查批次 30");
  await page
    .getByRole("dialog", { name: "库存变动详情", exact: true })
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await page.getByRole("tab", { name: "SKU 库存", exact: true }).click();
  await expect(rows).toHaveCount(10);
  await page.locator(".el-pager li").filter({ hasText: /^2$/ }).click();
  await expect(page).toHaveURL(/page=2/);
  await page.getByPlaceholder("搜索商品、规格或变动编号 / 原因").fill("p01-s1");
  await expect(rows).toHaveCount(1);
  await expect(page).not.toHaveURL(/page=2/);
});
test("库存提交返回异常结果时保留原请求，刷新后可按原参数重试", async ({
  page,
}) => {
  await page.goto("/admin/inventory?q=p01-s1");
  await page.getByRole("button", { name: "补货 / 调整" }).click();
  const dialog = page.getByRole("dialog", { name: "调整库存", exact: true });
  await dialog
    .getByLabel("调整数量（正数补货，负数盘亏）", { exact: true })
    .fill("3");
  await dialog
    .getByPlaceholder("例如：到货入库 / 盘点修正")
    .fill("异常响应原参数重试");
  const before = await state(page),
    calls: unknown[][] = [];
  await page.route("**/api/actions/adjustStock", async (route) => {
    calls.push(route.request().postDataJSON().args);
    if (calls.length === 1)
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ result: null }),
      });
    else await route.continue();
  });
  await dialog.getByRole("button", { name: "确认调整", exact: true }).click();
  await expect(dialog).toContainText("结果未知");
  expect((await state(page)).inventory).toEqual(before.inventory);
  await page.reload();
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("button", { name: "按原请求重试", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  expect(calls).toHaveLength(2);
  expect(calls[1]).toEqual(calls[0]);
  const after = await state(page);
  expect(after.inventory).toHaveLength(before.inventory.length + 1);
  expect(after.products[0].skus[0].stock).toBe(
    before.products[0].skus[0].stock + 3,
  );
});
test("库存全局排序的行序、箭头及前进后退 URL 一致", async ({ page }) => {
  await page.goto("/admin/inventory");
  const header = page.getByRole("columnheader", { name: "可售库存" });
  await header.click();
  await expect(page).toHaveURL(/sort=asc/);
  await expect(header).toHaveClass(/ascending/);
  await expect(
    page
      .locator(".el-table__body-wrapper tbody tr")
      .first()
      .locator("td")
      .nth(2),
  ).toContainText("0 件");
  await header.click();
  await expect(page).toHaveURL(/sort=desc/);
  await expect(header).toHaveClass(/descending/);
  await page.goBack();
  await expect(page).toHaveURL(/sort=asc/);
  await expect(header).toHaveClass(/ascending/);
  await page.goForward();
  await expect(page).toHaveURL(/sort=desc/);
  await expect(header).toHaveClass(/descending/);
});
test("库存提交成功后同步中断仍确认成功，恢复不重复补货", async ({ page }) => {
  await page.goto("/admin/inventory?q=p01-s1");
  await page.getByRole("button", { name: "补货 / 调整" }).click();
  const dialog = page.getByRole("dialog", { name: "调整库存", exact: true });
  await dialog
    .getByPlaceholder("例如：到货入库 / 盘点修正")
    .fill("同步失败已补货");
  const before = await state(page);
  let blocked = false,
    writes = 0;
  await page.route("**/api/bootstrap?role=admin", (route) =>
    blocked
      ? route.fulfill({ status: 503, json: { message: "库存同步故障" } })
      : route.continue(),
  );
  await page.route("**/api/actions/adjustStock", async (route) => {
    writes++;
    const response = await route.fetch();
    blocked = true;
    await route.fulfill({ response });
  });
  await dialog.getByRole("button", { name: "确认调整", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("alert").filter({ hasText: "操作已完成" }),
  ).toBeVisible();
  blocked = false;
  // Polling may finish recovery before a manual reconnect button can be clicked.
  await expect(
    page.getByRole("alert").filter({ hasText: "操作已完成" }),
  ).toHaveCount(0);
  await expect(
    page
      .locator(".el-table__body-wrapper tbody tr")
      .first()
      .locator("td")
      .nth(2),
  ).toContainText(`${before.products[0].skus[0].stock + 10} 件`);
  expect(writes).toBe(1);
  expect((await state(page)).inventory).toHaveLength(
    before.inventory.length + 1,
  );
  await page.reload();
  await expect(dialog).not.toBeVisible();
});
test("恢复存储不可写时不发送库存业务请求并保留草稿", async ({ page }) => {
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith("shopmate:stock-recovery:"))
        throw new Error("storage denied");
      return original.call(this, key, value);
    };
  });
  await page.goto("/admin/inventory?q=p01-s1");
  await page.getByRole("button", { name: "补货 / 调整" }).click();
  const dialog = page.getByRole("dialog", { name: "调整库存", exact: true });
  await dialog
    .getByPlaceholder("例如：到货入库 / 盘点修正")
    .fill("存储故障草稿");
  const before = await state(page);
  let writes = 0;
  await page.route("**/api/actions/adjustStock", (route) => {
    writes++;
    return route.continue();
  });
  await dialog.getByRole("button", { name: "确认调整", exact: true }).click();
  await expect(
    page.getByText(
      "无法保存库存请求恢复信息，请启用当前页存储后重试；尚未提交库存操作",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    dialog.getByPlaceholder("例如：到货入库 / 盘点修正"),
  ).toHaveValue("存储故障草稿");
  expect(writes).toBe(0);
  expect((await state(page)).inventory).toEqual(before.inventory);
});
