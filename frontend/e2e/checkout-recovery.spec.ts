import type { Page } from "@playwright/test";
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
  return (await (await page.request.get("/api/state?role=admin")).json()).db;
}
async function prepare(page: Page) {
  await page.request.post("/api/auth/login", {
    headers,
    data: { role: "admin", username: "admin", password: TEST_ADMIN_PASSWORD },
  });
  const now = Date.now();
  await action(page, "saveCoupon", {
    name: "故障恢复专用券",
    threshold: 100,
    discount: 1,
    claimStartsAt: new Date(now - 60000).toISOString(),
    claimEndsAt: new Date(now + 86400000).toISOString(),
    validFrom: new Date(now - 60000).toISOString(),
    validUntil: new Date(now + 86400000).toISOString(),
    totalLimit: 2,
    active: true,
  });
  await page.request.post("/api/auth/login", {
    headers,
    data: { role: "user", username: "lin", password: TEST_USER_PASSWORD },
  });
  const db = await state(page);
  const cartIds = db.carts.filter((c) => c.userId === "u1").map((c) => c.id);
  if (cartIds.length)
    await action(page, "batchCart", { action: "remove", ids: cartIds });
  await action(page, "claimCoupon", db.coupons[0]!.id);
  await action(page, "addCart", "p01", "p01-s1", 2);
  await page.goto("/checkout");
  await page
    .getByLabel("使用优惠券")
    .selectOption({ label: "故障恢复专用券 · 满 ¥1.00 减 ¥0.01" });
  await expect(
    page.getByRole("button", { name: "提交订单", exact: true }),
  ).toBeEnabled();
  return state(page);
}
async function verifyOneOrder(page: Page, before: Database) {
  const after = await state(page);
  const created = after.orders.filter(
    (o) => !before.orders.some((old) => old.id === o.id),
  );
  expect(created).toHaveLength(1);
  expect(created[0]!.status).toBe("pending");
  expect(after.inventory).toEqual(before.inventory);
  expect(after.ledger).toEqual(before.ledger);
  expect(after.carts.filter((c) => c.userId === "u1")).toHaveLength(0);
  expect(
    after.couponClaims.find((c) => c.id === created[0]!.coupon?.claimId)
      ?.orderId,
  ).toBe(created[0]!.id);
  expect(
    after.orderRequests.filter((r) => r.orderId === created[0]!.id),
  ).toHaveLength(1);
  return created[0]!;
}
test.beforeEach(() =>
  test.skip(!!process.env.PLAYWRIGHT_BASE_URL, "故障注入仅使用隔离夹具"),
);

test("下单成功响应丢失后刷新，通过只读查询恢复唯一订单", async ({ page }) => {
  const before = await prepare(page);
  let writes = 0,
    quotes = 0;
  await page.route("**/api/actions/createOrder", async (route) => {
    writes++;
    expect((await route.fetch()).ok()).toBe(true);
    await route.abort();
  });
  await page.route("**/api/actions/quoteCheckout", async (route) => {
    quotes++;
    await route.continue();
  });
  await page.getByRole("button", { name: "提交订单", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "结果暂无法确认" }).first(),
  ).toBeVisible();
  const marker = await page.evaluate(() =>
    JSON.parse(sessionStorage.getItem("shopmate:checkout:u1")!),
  );
  expect(Object.keys(marker).sort()).toEqual([
    "checkoutPath",
    "createdAt",
    "quoteId",
    "requestId",
    "userId",
  ]);
  await page.reload();
  await expect(page).toHaveURL(/\/orders\/[^/]+\/pay$/);
  const order = await verifyOneOrder(page, before);
  expect(page.url()).toContain(order.id);
  expect(writes).toBe(1);
  expect(quotes).toBe(0);
  expect(
    await page.evaluate(() => sessionStorage.getItem("shopmate:checkout:u1")),
  ).toBeNull();
});

test("尚未找到订单时保留原标识，迟到提交与明确重试返回同一订单", async ({
  page,
}) => {
  const before = await prepare(page);
  const payloads: { args: { quoteId: string; requestId: string }[] }[] = [];
  let quotes = 0;
  await page.route("**/api/actions/createOrder", async (route) => {
    payloads.push(route.request().postDataJSON());
    if (payloads.length === 1) await route.abort();
    else await route.continue();
  });
  await page.route("**/api/actions/quoteCheckout", async (route) => {
    quotes++;
    await route.continue();
  });
  await page.getByRole("button", { name: "提交订单", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "结果暂无法确认" }).first(),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByText(
      "尚未查询到订单。原请求可能仍在途中，请按原请求重试或继续核对。",
      { exact: true },
    ),
  ).toBeVisible();
  expect(payloads).toHaveLength(1);
  expect(quotes).toBe(0);
  const late = await page.request.post("/api/actions/createOrder", {
    headers,
    data: payloads[0],
  });
  expect(late.ok(), await late.text()).toBe(true);
  await page.getByRole("button", { name: "按原请求重试", exact: true }).click();
  await expect(page).toHaveURL(/\/orders\/[^/]+\/pay$/);
  // The late POST already completed the original command. Lookup-before-retry
  // recovers its result without issuing a second browser POST.
  expect(payloads).toHaveLength(1);
  expect(quotes).toBe(0);
  await verifyOneOrder(page, before);
});

test("会话存储不可写时阻止下单，保留报价供恢复存储后重试", async ({ page }) => {
  const before = await prepare(page);
  let writes = 0;
  await page.route("**/api/actions/createOrder", async (route) => {
    writes++;
    await route.continue();
  });
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith("shopmate:checkout:"))
        throw new Error("storage unavailable");
      return original.call(this, key, value);
    };
  });
  await page.getByRole("button", { name: "提交订单", exact: true }).click();
  await expect(page.getByText(/无法保存结算恢复标识/)).toBeVisible();
  expect(writes).toBe(0);
  expect((await state(page)).orders).toEqual(before.orders);
  await expect(
    page.getByRole("button", { name: "提交订单", exact: true }),
  ).toBeEnabled();
});

test("离开结算后迟到的恢复响应不能抢回页面或删除恢复标识", async ({ page }) => {
  await prepare(page);
  await page.route("**/api/actions/createOrder", async (route) => {
    await route.fetch();
    await route.abort();
  });
  await page.getByRole("button", { name: "提交订单", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "结果暂无法确认" }).first(),
  ).toBeVisible();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let observed!: () => void;
  const started = new Promise<void>((resolve) => {
    observed = resolve;
  });
  await page.route("**/api/order-requests/**", async (route) => {
    const response = await route.fetch();
    observed();
    await held;
    await route.fulfill({ response });
  });
  await page.reload();
  await started;
  await page.getByRole("link", { name: "我的订单", exact: true }).click();
  await expect(page).toHaveURL(/\/orders$/);
  const returned = page.waitForResponse((r) =>
    r.url().includes("/api/order-requests/"),
  );
  release();
  await returned;
  await expect(
    page.getByRole("heading", { name: "我的订单", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/orders$/);
  expect(
    await page.evaluate(() => sessionStorage.getItem("shopmate:checkout:u1")),
  ).not.toBeNull();
});
