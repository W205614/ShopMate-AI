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
async function state(page: Page) {
  return (await readSnapshot(page.request, "admin")).db;
}
test.beforeEach(async ({ page }) => {
  test.skip(!!process.env.PLAYWRIGHT_BASE_URL, "评价管理仅使用隔离夹具");
  for (const role of ["user", "admin"]) {
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
  }
});
const bodyRows = (page: Page) =>
  page.locator(".el-table__body-wrapper tbody tr");
test("全退历史优先于隐藏，拒绝陈旧恢复操作，用户仍可删除历史", async ({
  page,
}) => {
  const order = (await state(page)).orders.find(
      (o: { id: string }) => o.id === "SM000001",
    ),
    line = order.items[0];
  await action(page, "submitReview", {
    orderId: order.id,
    orderItemId: line.id,
    rating: 5,
    content: "全退评价历史仍然可查",
  });
  const review = (await state(page)).reviews[0];
  await action(page, "moderateReview", review.id, true);
  await action(
    page,
    "requestAfterSale",
    order.id,
    "规格不合适",
    "评价后整行退货",
    [{ orderItemId: line.id, quantity: line.quantity }],
  );
  const sale = (await state(page)).afterSales[0];
  await action(page, "processAfterSale", sale.id, "approve");
  await action(page, "submitReturn", sale.id, "模拟物流", "REVIEW-RETURN");
  await action(page, "processAfterSale", sale.id, "receive");
  await action(page, "processAfterSale", sale.id, "refund");
  await page.goto("/admin/reviews");
  const row = bodyRows(page).filter({ hasText: review.content });
  await expect(row.locator(".el-tag")).toHaveText("已全退，仅保留历史");
  await expect(
    row.getByRole("button", { name: "恢复展示", exact: true }),
  ).toHaveCount(0);
  const before = await state(page);
  const rejectionRequestId = crypto.randomUUID();
  expect(
    (
      await page.request.post("/api/actions/moderateReview", {
        headers,
        data: { args: [review.id, false], requestId: rejectionRequestId },
      })
    ).status(),
  ).toBe(400);
  const after = await state(page);
  const { auditEntries: beforeAudit = [], ...beforeBusiness } = before;
  const { auditEntries: afterAudit = [], ...afterBusiness } = after;
  expect(afterBusiness).toEqual(beforeBusiness);
  expect(
    afterAudit.filter((entry) =>
      beforeAudit.some((old) => old.id === entry.id),
    ),
  ).toEqual(beforeAudit);
  expect(
    afterAudit.filter(
      (entry) => !beforeAudit.some((old) => old.id === entry.id),
    ),
  ).toEqual([
    expect.objectContaining({
      actorId: "admin",
      action: "moderateReview",
      objectId: review.id,
      requestId: rejectionRequestId,
      result: "rejected:400",
    }),
  ]);
  const visible = await (
    await page.request.get(`/api/products/${line.productId}/reviews`)
  ).json();
  expect(visible).toMatchObject({ total: 0, averageRating: 0 });
  await page.goto("/account?section=reviews");
  await expect(page.locator(".commerce-badge")).toHaveText(
    "已全退，仅保留历史",
  );
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "删除评价", exact: true }).click();
  await expect(page.locator(".commerce-badge")).toContainText("已删除");
  await page.goto("/admin/reviews?status=deleted");
  await expect(bodyRows(page)).toContainText("用户已删除");
  await expect(
    page.getByRole("button", { name: "恢复展示", exact: true }),
  ).toHaveCount(0);
});
test("四页真实购买评价可筛选定位，隐藏导致末页收敛且公开评分一致", async ({
  page,
}) => {
  test.setTimeout(120000);
  await action(page, "adjustStock", "p01", "p01-s1", 50, 0, "评价分页夹具补货");
  const ids: string[] = [];
  for (let i = 0; i < 31; i++) {
    const quote = await action(page, "quoteCheckout", {
      source: {
        type: "buyNow",
        productId: "p01",
        skuId: "p01-s1",
        quantity: 1,
      },
      addressId: "a1",
    });
    const id = await action(page, "createOrder", {
      quoteId: quote.id,
      requestId: `review-pages-${i}`,
    });
    await action(page, "payOrder", id);
    await action(page, "shipOrder", id, "模拟物流", `REVIEW-${i}`);
    await action(page, "confirmOrder", id);
    const line = (await state(page)).orders.find(
      (o: { id: string }) => o.id === id,
    ).items[0];
    await action(page, "submitReview", {
      orderId: id,
      orderItemId: line.id,
      rating: 5,
      content: `分页真实购买评价${String(i).padStart(2, "0")}`,
    });
    ids.push(id);
  }
  await page.goto("/admin/reviews?status=visible&page=4");
  await expect(bodyRows(page)).toHaveCount(1);
  await expect(bodyRows(page)).toContainText("分页真实购买评价00");
  await page.reload();
  await expect(bodyRows(page)).toHaveCount(1);
  await bodyRows(page)
    .getByRole("button", { name: "隐藏评价", exact: true })
    .click();
  await expect(page).toHaveURL(/page=3/);
  await expect(bodyRows(page)).toHaveCount(10);
  await page.goto(`/admin/reviews?orderId=${ids[4]}&status=visible`);
  await expect(bodyRows(page)).toHaveCount(1);
  await expect(bodyRows(page)).toContainText("分页真实购买评价04");
  await bodyRows(page).getByRole("link", { name: ids[4], exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/orders\\?detail=${ids[4]}`));
  await expect(page.getByRole("dialog")).toContainText(ids[4]!);
  await page.goBack();
  await expect(bodyRows(page)).toHaveCount(1);
  await page
    .getByPlaceholder("商品 / 内容 / 订单号 / 评价编号")
    .fill("不存在的评价");
  await expect(bodyRows(page)).toHaveCount(0);
  await page.goto("/admin/reviews?status=hidden");
  await expect(bodyRows(page)).toHaveCount(1);
  await page.goBack();
  await expect(bodyRows(page)).toHaveCount(0);
  await page.goForward();
  await expect(bodyRows(page)).toHaveCount(1);
  const visible = await (
    await page.request.get("/api/products/p01/reviews")
  ).json();
  expect(visible).toMatchObject({ total: 30, averageRating: 5 });
  await page.goto("/admin/reviews?detail=unknown-review");
  await expect(page.getByRole("dialog")).toContainText("没有找到该评价");
});
