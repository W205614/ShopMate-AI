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
test.beforeEach(async ({ page }) => {
  test.skip(!!process.env.PLAYWRIGHT_BASE_URL, "售后工作台仅使用隔离夹具");
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
test("另一管理页推进时未编辑说明同步，已编辑草稿保留并可显式加载最新说明", async ({
  page,
  context,
}) => {
  await action(
    page,
    "requestAfterSale",
    "SM000001",
    "协作核对",
    "核对跨管理页说明草稿",
    [{ orderItemId: "SM000001-line-1", quantity: 1 }],
  );
  const id = (await state(page)).afterSales[0].id;
  await page.goto(`/admin/after-sales?detail=${id}`);
  const dialog = page.getByRole("dialog", { name: "售后处理", exact: true });
  const note = dialog.getByPlaceholder("填写审核或收货情况；拒绝时必填");
  const other = await context.newPage();
  await other.goto(`/admin/after-sales?detail=${id}`);
  await action(other, "processAfterSale", id, "approve", "另一管理页同意退货");
  await expect(note).toHaveValue("另一管理页同意退货");
  await note.fill("本地退款前核对草稿");
  await action(other, "submitReturn", id, "模拟退货", "R");
  await action(
    other,
    "processAfterSale",
    id,
    "receive",
    "另一管理页已确认收货",
  );
  await expect(
    dialog
      .getByRole("alert")
      .filter({ hasText: "处理说明已被其他页面更新，当前草稿已保留" }),
  ).toBeVisible();
  await expect(note).toHaveValue("本地退款前核对草稿");
  await dialog
    .getByRole("button", { name: "加载最新处理说明", exact: true })
    .click();
  await expect(note).toHaveValue("另一管理页已确认收货");
  await note.fill("本页退款核对完成");
  await dialog
    .getByRole("button", { name: "执行模拟退款", exact: true })
    .click();
  await page
    .locator(".el-message-box")
    .getByRole("button", { name: "确定", exact: true })
    .click();
  await expect(dialog.getByText("已退款", { exact: true })).toBeVisible();
  await expect(note).toHaveValue("本页退款核对完成");
  await other.reload();
  await expect(
    other.getByRole("dialog", { name: "售后处理", exact: true }),
  ).toContainText("本页退款核对完成");
});
test("确认期间浏览器回退切换申请，不处理另一笔售后或沿用旧说明", async ({
  page,
}) => {
  for (const orderId of ["SM000001", "SM000003"])
    await action(
      page,
      "requestAfterSale",
      orderId,
      "切换保护",
      "核对处理对象与说明",
      [{ orderItemId: `${orderId}-line-1`, quantity: 1 }],
    );
  const records = (await state(page)).afterSales;
  const first = records.find(
    (a: { orderId: string }) => a.orderId === "SM000001",
  ).id;
  const second = records.find(
    (a: { orderId: string }) => a.orderId === "SM000003",
  ).id;
  await page.goto(`/admin/after-sales?detail=${second}`);
  const dialog = page.getByRole("dialog", { name: "售后处理", exact: true });
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page
    .locator(".el-table__body-wrapper tbody tr")
    .filter({ hasText: first })
    .getByRole("button", { name: "查看处理", exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`detail=${first}`));
  await dialog
    .getByPlaceholder("填写审核或收货情况；拒绝时必填")
    .fill("第一笔申请的说明");
  let writes = 0;
  await page.route("**/api/actions/processAfterSale", async (route) => {
    writes++;
    await route.continue();
  });
  await dialog.getByRole("button", { name: "批准申请", exact: true }).click();
  await expect(page.locator(".el-message-box")).toContainText(first);
  await page.goBack();
  await expect(page).not.toHaveURL(/detail=/);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`detail=${second}`));
  await expect(page.locator(".el-message-box")).not.toBeVisible();
  expect(writes).toBe(0);
  expect(
    (await state(page)).afterSales.every(
      (a: { status: string }) => a.status === "requested",
    ),
  ).toBe(true);
  await expect(
    dialog.getByPlaceholder("填写审核或收货情况；拒绝时必填"),
  ).toHaveValue("");
  await dialog.getByRole("button", { name: "批准申请", exact: true }).click();
  await page
    .locator(".el-message-box")
    .getByRole("button", { name: "确定", exact: true })
    .click();
  await expect(dialog.getByText("已批准", { exact: true })).toBeVisible();
  expect(writes).toBe(1);
  const after = (await state(page)).afterSales;
  expect(after.find((a: { id: string }) => a.id === first).status).toBe(
    "requested",
  );
  expect(after.find((a: { id: string }) => a.id === second).note).toBe("");
});
test("售后四页数据查询、状态、刷新和前进后退保留 URL", async ({ page }) => {
  test.setTimeout(90000);
  let latest = "";
  for (let i = 0; i < 31; i++) {
    await action(
      page,
      "requestAfterSale",
      "SM000001",
      "运营工单",
      `运营检索申请 ${i}`,
      [{ orderItemId: "SM000001-line-1", quantity: 1 }],
    );
    latest = (await state(page)).afterSales[0].id;
    if (i < 30)
      await action(
        page,
        "processAfterSale",
        latest,
        "reject",
        `历史拒绝说明 ${i}`,
      );
  }
  const before = (await state(page)).afterSales;
  await page.goto("/admin/after-sales?q=SM000001");
  const rows = page.locator(".el-table__body-wrapper tbody tr");
  await expect(rows).toHaveCount(10);
  await page.locator(".el-pager li").filter({ hasText: /^4$/ }).click();
  await expect(rows).toHaveCount(1);
  await page.reload();
  await expect(page).toHaveURL(/page=4/);
  await expect(rows).toHaveCount(1);
  await page.locator(".el-pager li").filter({ hasText: /^3$/ }).click();
  await expect(page).toHaveURL(/page=3/);
  await page.goBack();
  await expect(page).toHaveURL(/page=4/);
  await page.goForward();
  await expect(page).toHaveURL(/page=3/);
  await page.getByPlaceholder("售后编号 / 订单号").fill(latest);
  await expect(rows).toHaveCount(1);
  await expect(page).not.toHaveURL(/page=3/);
  await page.locator(".admin-toolbar .el-select").click();
  await page.getByRole("option", { name: "待审核", exact: true }).click();
  await expect(rows).toHaveCount(1);
  await page.locator(".admin-toolbar .el-select").click();
  await page.getByRole("option", { name: "已拒绝", exact: true }).click();
  await expect(rows).toHaveCount(0);
  expect((await state(page)).afterSales).toEqual(before);
});
test("双向定位与退货退款操作、阻止原因及处理说明在双端一致", async ({
  page,
  context,
}) => {
  await page.goto("/orders/SM000001");
  await page.getByRole("button", { name: "申请售后", exact: true }).click();
  await page.getByLabel("问题说明").fill("双端售后工作台验收");
  await page.getByRole("button", { name: "提交申请", exact: true }).click();
  await expect(
    page.getByText("待审核 · 不再需要", { exact: true }),
  ).toBeVisible();
  const id = (await state(page)).afterSales[0].id;
  await page.goto("/after-sales");
  const customer = page.locator(".order-block").filter({ hasText: id });
  const management = await context.newPage();
  await management.goto("/admin/orders?detail=SM000001");
  await management.getByRole("link", { name: new RegExp(id) }).click();
  await expect(management).toHaveURL(new RegExp(`detail=${id}`));
  const dialog = management.getByRole("dialog", {
    name: "售后处理",
    exact: true,
  });
  const note = dialog.getByPlaceholder("填写审核或收货情况；拒绝时必填");
  await note.fill("同意退货，请填写模拟物流");
  await dialog.getByRole("button", { name: "批准申请", exact: true }).click();
  await management
    .locator(".el-message-box")
    .getByRole("button", { name: "确定", exact: true })
    .click();
  await expect(dialog.getByText("已批准", { exact: true })).toBeVisible();
  await expect(dialog).toContainText("请填写模拟承运商与单号");
  await expect(customer).toContainText("同意退货，请填写模拟物流");
  await expect(customer).toContainText("请填写模拟承运商与单号");
  await expect(
    dialog.getByRole("button", { name: "确认收到退货", exact: true }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "执行模拟退款", exact: true }),
  ).toHaveCount(0);
  await customer
    .getByLabel("模拟退货承运商", { exact: true })
    .fill("模拟退货承运商");
  await customer.getByLabel("模拟退货单号", { exact: true }).fill("R");
  await customer
    .getByRole("button", { name: "提交退货单号", exact: true })
    .click();
  await expect(customer.getByText("退货运输中", { exact: true })).toBeVisible();
  await expect(
    customer.getByRole("button", { name: "撤销申请", exact: true }),
  ).toHaveCount(0);
  await note.fill("已核对收到一件退货");
  await dialog
    .getByRole("button", { name: "确认收到退货", exact: true })
    .click();
  await management
    .locator(".el-message-box")
    .getByRole("button", { name: "确定", exact: true })
    .click();
  await expect(dialog.getByText("已收货", { exact: true })).toBeVisible();
  await expect(customer).toContainText("已核对收到一件退货");
  await note.fill("模拟退款完成并回补库存");
  await dialog
    .getByRole("button", { name: "执行模拟退款", exact: true })
    .click();
  await management
    .locator(".el-message-box")
    .getByRole("button", { name: "确定", exact: true })
    .click();
  await expect(dialog.getByText("已退款", { exact: true })).toBeVisible();
  await expect(customer).toContainText("模拟退款完成并回补库存");
  await dialog.getByRole("link", { name: "查看关联订单", exact: true }).click();
  const order = management.getByRole("dialog", {
    name: "订单详情",
    exact: true,
  });
  await expect(order).toContainText("SM000001");
  await expect(order).toContainText("已退款");
  await management.goto("/admin/after-sales?detail=missing-sale");
  await expect(
    management.getByRole("alert").filter({ hasText: "没有找到该售后申请" }),
  ).toBeVisible();
});
