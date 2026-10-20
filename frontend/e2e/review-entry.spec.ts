import { readSnapshot } from "./api-snapshot";
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
test.beforeEach(async ({ page }) => {
  test.skip(!!process.env.PLAYWRIGHT_BASE_URL, "评价变更仅使用隔离夹具");
  await page.request.post("/api/auth/login", {
    headers,
    data: { role: "user", username: "lin", password: TEST_USER_PASSWORD },
  });
});
test("待评价订单定位隔离，切换个人中心和刷新不遗留隐藏条件", async ({
  page,
}) => {
  await page.goto("/account?section=pending-reviews&orderId=SM000003");
  await expect(page.locator(".commerce-list-card")).toHaveCount(1);
  await expect(page.locator(".commerce-list-card")).toContainText("SM000003");
  await page.reload();
  await expect(page.locator(".commerce-list-card")).toHaveCount(1);
  await page.getByRole("link", { name: "查看全部待评价", exact: true }).click();
  await expect(page.locator(".commerce-list-card")).toHaveCount(2);
  for (const id of ["SM000002", "missing"]) {
    await page.goto(`/account?section=pending-reviews&orderId=${id}`);
    await expect(
      page.getByRole("heading", { name: "未找到可访问的订单" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "写评价", exact: true }),
    ).toHaveCount(0);
  }
  await page.getByRole("button", { name: "个人资料", exact: true }).click();
  await expect(page).not.toHaveURL(/orderId=/);
  await page.getByRole("button", { name: "待评价", exact: true }).click();
  await expect(page.locator(".commerce-list-card")).toHaveCount(2);
});
test("售后中停止评价并保留草稿，撤销后恢复；整行退款无无效入口", async ({
  page,
}) => {
  await page.goto("/orders/SM000001");
  await page.getByRole("link", { name: "评价商品", exact: true }).click();
  await page.getByRole("button", { name: "写评价", exact: true }).click();
  await page
    .getByLabel("评价内容", { exact: true })
    .fill("这是尚未提交的使用体验草稿");
  const requestSale = () =>
    action(
      page,
      "requestAfterSale",
      "SM000001",
      "不再需要",
      "测试售后期间评价资格",
      [{ orderItemId: "SM000001-line-1", quantity: 1 }],
    );
  await requestSale();
  await expect(page.getByText(/售后处理中，暂不可评价/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "发布评价", exact: true }),
  ).toHaveCount(0);
  let db = (await readSnapshot(page.request, "user")).db;
  await action(page, "cancelAfterSale", db.afterSales[0].id);
  await expect(page.getByLabel("评价内容", { exact: true })).toHaveValue(
    "这是尚未提交的使用体验草稿",
  );
  await expect(
    page.getByRole("button", { name: "发布评价", exact: true }),
  ).toBeEnabled();
  await requestSale();
  await page.request.post("/api/auth/login", {
    headers,
    data: { role: "admin", username: "admin", password: TEST_ADMIN_PASSWORD },
  });
  db = (await readSnapshot(page.request, "user")).db;
  const saleId = db.afterSales.find(
    (a: { status: string }) => a.status === "requested",
  ).id;
  await action(page, "processAfterSale", saleId, "approve");
  await action(page, "submitReturn", saleId, "模拟退货", "RETURN12345");
  await action(page, "processAfterSale", saleId, "receive");
  await action(page, "processAfterSale", saleId, "refund");
  await page.goto("/orders/SM000001");
  await expect(page.getByText(/该商品已全部退款，不能评价/)).toBeVisible();
  await expect(
    page.getByRole("link", { name: "评价商品", exact: true }),
  ).toHaveCount(0);
});
