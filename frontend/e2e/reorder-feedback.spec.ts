import { readSnapshot } from "./api-snapshot";
import { test, expect, TEST_USER_PASSWORD } from "./fixtures";
test("列表和详情再次购买报告新增项数与件数，与购物车一致且不下单付款", async ({
  page,
}) => {
  test.skip(!!process.env.PLAYWRIGHT_BASE_URL, "再次购买写入仅使用隔离夹具");
  const headers = { "X-ShopMate-Request": "1" };
  await page.request.post("/api/auth/login", {
    headers,
    data: { role: "user", username: "lin", password: TEST_USER_PASSWORD },
  });
  const action = async (method: string, ...args: unknown[]) => {
    const response = await page.request.post(`/api/actions/${method}`, {
      headers,
      data: { args },
    });
    expect(response.ok(), await response.text()).toBe(true);
    return (await response.json()).result;
  };
  const state = async () =>
    (await readSnapshot(page.request, "user")).db;
  const before = await state();
  const ids = before.carts.map((c: { id: string }) => c.id);
  if (ids.length) await action("batchCart", { action: "remove", ids });
  const quote = await action("quoteCheckout", {
    source: { type: "buyNow", productId: "p05", skuId: "p05-s1", quantity: 3 },
    addressId: "a1",
  });
  const orderId = await action("createOrder", {
    quoteId: quote.id,
    requestId: crypto.randomUUID(),
  });
  const orders = (await state()).orders;
  await page.goto(`/orders/${orderId}`);
  await page.getByRole("button", { name: "再次购买", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("已加入 1 项，共 3 件");
  expect((await state()).carts[0].quantity).toBe(3);
  await page.goto("/orders");
  await page
    .locator(".order-block")
    .filter({ hasText: orderId })
    .getByRole("button", { name: "再次购买", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("已加入 1 项，共 3 件");
  expect((await state()).carts[0].quantity).toBe(6);
  expect((await state()).orders).toEqual(orders);
  await page.goto("/cart");
  await expect(page.getByRole("spinbutton")).toHaveValue("6");
  await expect(page.locator(".summary-total")).toContainText("¥354.00");
});
