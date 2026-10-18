import type { Page } from "@playwright/test";
import type { Database } from "../../shared/domain/types";
import {
  test,
  expect,
  TEST_ADMIN_PASSWORD,
  TEST_USER_PASSWORD,
} from "./fixtures";

const headers = { "X-ShopMate-Request": "1" };
async function post(page: Page, path: string, data: unknown) {
  const response = await page.request.post(path, { headers, data });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function action(page: Page, method: string, ...args: unknown[]) {
  return (await post(page, `/api/actions/${method}`, { args })).result;
}
async function state(page: Page): Promise<Database> {
  return (await (await page.request.get("/api/state")).json()).db;
}
async function login(page: Page, admin = false) {
  await post(page, "/api/auth/login", {
    role: admin ? "admin" : "user",
    username: admin ? "admin" : "lin",
    password: admin ? TEST_ADMIN_PASSWORD : TEST_USER_PASSWORD,
  });
}
test.beforeEach(() => {
  test.skip(
    !!process.env.PLAYWRIGHT_BASE_URL &&
      process.env.E2E_MUTATIONS_ALLOWED !== "1",
    "Mutating flows run only against a fixture database or explicitly isolated acceptance deployment",
  );
});

test("立即购买用券、部分退款、余量退货退款守恒，购物车不受影响", async ({
  page,
}) => {
  await login(page, true);
  const now = Date.now();
  await action(page, "saveCoupon", {
    name: "验收满减券",
    threshold: 10000,
    discount: 1001,
    claimStartsAt: new Date(now - 60000).toISOString(),
    claimEndsAt: new Date(now + 86400000).toISOString(),
    validFrom: new Date(now - 60000).toISOString(),
    validUntil: new Date(now + 86400000).toISOString(),
    totalLimit: 2,
    active: true,
  });
  await login(page);
  const coupon = (await state(page)).coupons[0]!;
  await action(page, "claimCoupon", coupon.id);
  await action(page, "addCart", "p01", "p01-s1", 1);
  const originalCart = (await state(page)).carts;
  await page.goto("/products/p05");
  await page.getByRole("spinbutton", { name: "购买数量" }).fill("3");
  await page.getByRole("button", { name: "立即购买", exact: true }).click();
  await expect(page).toHaveURL(/checkout\?.*productId=p05/);
  await page
    .getByLabel("使用优惠券")
    .selectOption({ label: "验收满减券 · 满 ¥100.00 减 ¥10.01" });
  await expect(page.locator(".summary-total")).toContainText("¥166.99");
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(
      page.getByRole("button", { name: "提交订单", exact: true }),
    ).toBeEnabled();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    for (const section of await page
      .locator(
        ".checkout-layout .checkout-section, .checkout-layout .order-summary",
      )
      .all()) {
      const bounds = await section.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    }
  }
  await page.getByRole("button", { name: "提交订单", exact: true }).click();
  await expect(page).toHaveURL(/\/orders\/[^/]+\/pay$/);
  const orderId = page.url().split("/").at(-2)!;
  expect((await state(page)).carts).toEqual(originalCart);
  await page.getByRole("button", { name: "确认模拟支付", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "模拟支付成功", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "查看订单", exact: true }).click();
  await page.getByRole("button", { name: "申请售后", exact: true }).click();
  await page
    .getByRole("spinbutton", { name: "日常 陶瓷马克杯 售后数量", exact: true })
    .fill("1");
  await page
    .getByLabel("问题说明")
    .fill("验收部分商品退款，不影响剩余商品履约");
  await page.getByRole("button", { name: "提交申请", exact: true }).click();
  await expect(
    page.getByText("待审核 · 不再需要", { exact: true }),
  ).toBeVisible();
  let db = await state(page);
  const firstSale = db.afterSales[0]!;
  expect(firstSale.refundAmount).toBe(5566);
  await action(page, "processAfterSale", firstSale.id, "approve");
  await action(page, "processAfterSale", firstSale.id, "refund");
  await action(page, "processAfterSale", firstSale.id, "refund");
  db = await state(page);
  expect(db.orders.find((o) => o.id === orderId)).toMatchObject({
    status: "paid",
    refundedAmount: 5566,
  });
  await action(page, "shipOrder", orderId, "模拟快递", "SHIP12345");
  await page.reload();
  await page.getByRole("button", { name: "确认收货", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "已完成", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "申请售后", exact: true }).click();
  await page
    .getByRole("spinbutton", { name: "日常 陶瓷马克杯 售后数量", exact: true })
    .fill("2");
  await page.getByLabel("问题说明").fill("验收余下商品退货退款与尾差");
  await page.getByRole("button", { name: "提交申请", exact: true }).click();
  await expect(
    page.getByText("待审核 · 不再需要", { exact: true }),
  ).toBeVisible();
  const secondSale = (await state(page)).afterSales.find(
    (a) => a.id !== firstSale.id,
  )!;
  await action(page, "processAfterSale", secondSale.id, "approve");
  await page.goto("/after-sales");
  const record = page
    .locator(".order-block")
    .filter({ hasText: "验收余下商品退货退款与尾差" });
  await record.getByLabel("模拟退货单号").fill("RETURN12345");
  await record.getByRole("button", { name: "提交退货单号" }).click();
  await expect(record.getByText("退货运输中", { exact: true })).toBeVisible();
  await expect(record.getByRole("button", { name: "撤销申请" })).toHaveCount(0);
  await action(page, "processAfterSale", secondSale.id, "receive");
  await action(page, "processAfterSale", secondSale.id, "refund");
  db = await state(page);
  expect(db.orders.find((o) => o.id === orderId)).toMatchObject({
    status: "refunded",
    total: 16699,
    refundedAmount: 16699,
    items: [expect.objectContaining({ refundedQuantity: 3 })],
  });
  expect(db.afterSales.reduce((n, a) => n + a.refundAmount, 0)).toBe(16699);
  expect(db.couponClaims[0]?.status).toBe("used");
  await page.goto(`/orders/${orderId}`);
  await expect(
    page.getByRole("heading", { name: "已退款", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("已退款 ¥166.99，剩余实付 ¥0.00", { exact: true }),
  ).toBeVisible();
});

test("结算地址编辑要求重新确认报价；购物车批量只选择可结算条目", async ({
  page,
}) => {
  await login(page, true);
  await login(page);
  await action(page, "addCart", "p01", "p01-s1", 1);
  await action(page, "addCart", "p05", "p05-s1", 2);
  await action(page, "toggleProduct", "p01");
  await page.goto("/cart");
  await page.getByRole("checkbox", { name: "全选", exact: false }).uncheck();
  await expect(
    page.getByRole("checkbox", { name: "选择 静听 无线头戴耳机" }),
  ).not.toBeChecked();
  await page.getByRole("checkbox", { name: "全选", exact: false }).check();
  await expect(
    page.getByRole("checkbox", { name: "选择 静听 无线头戴耳机" }),
  ).not.toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "选择 日常 陶瓷马克杯" }),
  ).toBeChecked();
  await page.getByRole("button", { name: "清理失效商品", exact: true }).click();
  await expect(page.locator(".cart-row")).toHaveCount(1);
  await page.getByRole("link", { name: "去结算", exact: false }).click();
  await expect(
    page.getByRole("button", { name: "提交订单", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "编辑 林小满（演示） 的地址" })
    .click();
  await page.getByLabel("配送省份", { exact: true }).fill("上海市");
  await page.getByLabel("详细地址", { exact: true }).fill("验收新路 10 号");
  await page.getByRole("button", { name: "保存地址", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "提交订单", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "重新获取报价", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "提交订单", exact: true }),
  ).toBeEnabled();
  await expect(page.locator(".address-options")).toContainText(
    "验收新路 10 号",
  );
});

test("订单搜索、状态和分页通过 URL 保留并支持前进后退", async ({ page }) => {
  await login(page);
  for (let index = 0; index < 11; index++) {
    const quote = await action(page, "quoteCheckout", {
      source: {
        type: "buyNow",
        productId: "p05",
        skuId: "p05-s1",
        quantity: 1,
      },
      addressId: "a1",
    });
    await action(page, "createOrder", {
      quoteId: quote.id,
      requestId: `pagination-check-${index}`,
    });
  }
  await page.goto("/orders");
  await expect(page.locator(".order-block")).toHaveCount(10);
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page).toHaveURL(/page=2/);
  await expect(page.locator(".order-block")).toHaveCount(5);
  await page.reload();
  await expect(page.locator(".order-block")).toHaveCount(5);
  await page
    .getByRole("textbox", { name: "订单号或商品名称" })
    .fill("SM000005");
  await page.getByRole("button", { name: "搜索订单", exact: true }).click();
  await expect(page.locator(".order-block")).toHaveCount(1);
  await expect(page.locator(".order-block")).toContainText("SM000005");
  await page.getByRole("button", { name: "待发货", exact: true }).click();
  await expect(page).toHaveURL(/q=SM000005&status=paid/);
  await page.reload();
  await expect(
    page.getByRole("textbox", { name: "订单号或商品名称" }),
  ).toHaveValue("SM000005");
  await page.getByRole("button", { name: "已完成", exact: true }).click();
  await expect(page.locator(".order-block")).toHaveCount(0);
  await page.goBack();
  await expect(page.locator(".order-block")).toHaveCount(1);
});
