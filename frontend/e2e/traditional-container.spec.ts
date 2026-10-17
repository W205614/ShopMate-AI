import { randomUUID } from "node:crypto";
import { test, expect, TEST_ADMIN_PASSWORD } from "./fixtures";
import type {
  Database,
  CheckoutQuote,
  PublicReviews,
} from "../../shared/domain/types";

// This test intentionally writes business data. External targets must be isolated deployments.
test("真实服务端完成领券、报价下单、收货评价和分批退货退款", async ({
  page,
}) => {
  test.skip(
    !!process.env.PLAYWRIGHT_BASE_URL &&
      process.env.E2E_MUTATIONS_ALLOWED !== "1",
    "写入式验收仅用于明确允许的隔离部署",
  );
  const request = page.request;
  const headers = { "X-ShopMate-Request": "1" };
  async function action<T = void>(method: string, args: unknown[]): Promise<T> {
    const response = await request.post(`/api/actions/${method}`, {
      data: { args },
      headers,
    });
    expect(response.ok(), await response.text()).toBe(true);
    return (await response.json()).result as T;
  }
  async function state(role = "user"): Promise<Database> {
    return (await (await request.get(`/api/state?role=${role}`)).json()).db;
  }
  const username = "accept_" + randomUUID().replaceAll("-", "").slice(0, 16);
  const registered = await request.post("/api/auth/register", {
    headers,
    data: { username, name: "验收买家", password: "Acceptance123!" },
  });
  expect(registered.status()).toBe(201);
  const admin = await request.post("/api/auth/login", {
    headers,
    data: { username: "admin", role: "admin", password: TEST_ADMIN_PASSWORD },
  });
  expect(admin.ok()).toBe(true);
  const before = await state();
  const product = before.products.find(
    (p) => p.active && p.skus.some((s) => s.stock >= 2),
  )!;
  const sku = product.skus.find((s) => s.stock >= 2)!;
  await action("saveAddress", [
    {
      name: "验收收货人",
      phone: "13800000000",
      region: "上海市 徐汇区",
      detail: "隔离验收地址一号",
      isDefault: true,
    },
  ]);
  await action("saveCoupon", [
    {
      name: username + "满减券",
      threshold: sku.price,
      discount: 1,
      totalLimit: 1,
      active: true,
      claimStartsAt: new Date(Date.now() - 60000).toISOString(),
      claimEndsAt: new Date(Date.now() + 3600000).toISOString(),
      validFrom: new Date(Date.now() - 60000).toISOString(),
      validUntil: new Date(Date.now() + 86400000).toISOString(),
    },
  ]);
  const coupon = (await state()).coupons.find(
    (c) => c.name === username + "满减券",
  )!;
  await page.goto("/coupons");
  await expect(page.getByText(coupon.name, { exact: true })).toBeVisible();
  await action("claimCoupon", [coupon.id]);
  const db = await state();
  const quote = await action<CheckoutQuote>("quoteCheckout", [
    {
      source: {
        type: "buyNow",
        productId: product.id,
        skuId: sku.id,
        quantity: 2,
      },
      addressId: db.addresses[0]!.id,
      couponClaimId: db.couponClaims[0]!.id,
    },
  ]);
  expect(quote.total).toBe(2 * sku.price - 1);
  const creation = { quoteId: quote.id, requestId: randomUUID() };
  const orderId = await action<string>("createOrder", [creation]);
  expect(await action<string>("createOrder", [creation])).toBe(orderId);
  expect((await state()).carts).toEqual([]);
  await action("payOrder", [orderId]);
  await action("payOrder", [orderId]);
  await action("shipOrder", [orderId, "模拟物流", "ACCEPT-OUT"]);
  await action("confirmOrder", [orderId]);
  const line = (await state()).orders.find((o) => o.id === orderId)!.items[0]!;
  await action("submitReview", [
    {
      orderId,
      orderItemId: line.id,
      rating: 5,
      content: "隔离验收购买评价，商品信息清晰。",
    },
  ]);
  const publicBody = (await (
    await request.get(`/api/products/${product.id}/reviews`)
  ).json()) as PublicReviews;
  const visibleReview = publicBody.items.find(
    (r) => r.content === "隔离验收购买评价，商品信息清晰。",
  )!;
  expect(visibleReview.displayName).toBe("验**");
  expect(visibleReview).not.toHaveProperty("orderId");
  expect(visibleReview).not.toHaveProperty("userId");
  await page.goto(`/products/${product.id}`);
  await expect(
    page.getByText("隔离验收购买评价，商品信息清晰。", { exact: true }),
  ).toBeVisible();
  let amount = 0;
  for (let i = 0; i < 2; i++) {
    await action("requestAfterSale", [
      orderId,
      "规格不合适",
      "隔离验收分批退货",
      [{ orderItemId: line.id, quantity: 1 }],
    ]);
    const sale = (await state()).afterSales.find(
      (s) => s.orderId === orderId && s.status === "requested",
    )!;
    amount += sale.refundAmount;
    await action("processAfterSale", [sale.id, "approve", "批准隔离验收申请"]);
    await action("submitReturn", [sale.id, "模拟物流", `ACCEPT-IN-${i}`]);
    await action("processAfterSale", [sale.id, "receive", "模拟收到退货"]);
    await action("processAfterSale", [sale.id, "refund", "完成模拟退款"]);
    await action("processAfterSale", [sale.id, "refund", "重复请求不重复退款"]);
  }
  expect(amount).toBe(quote.total);
  const result = await state("admin"),
    order = result.orders.find((o) => o.id === orderId)!;
  expect(order.status).toBe("refunded");
  expect(order.refundedAmount).toBe(order.total);
  expect(
    result.products
      .find((p) => p.id === product.id)!
      .skus.find((s) => s.id === sku.id)!.stock,
  ).toBe(sku.stock);
  expect(
    result.ledger.filter(
      (l) => l.reference === orderId && l.type === "payment",
    ),
  ).toHaveLength(1);
  expect(
    result.ledger.filter((l) => l.reference === orderId && l.type === "refund"),
  ).toHaveLength(2);
  const afterReviews = (await (
    await request.get(`/api/products/${product.id}/reviews`)
  ).json()) as PublicReviews;
  expect(afterReviews.items.some((r) => r.id === visibleReview.id)).toBe(false);
  await page.goto(`/orders/${orderId}`);
  await expect(
    page.getByRole("heading", { name: "已退款", exact: true }),
  ).toBeVisible();
});
