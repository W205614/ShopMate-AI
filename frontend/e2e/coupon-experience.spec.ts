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
async function state(page: Page, role = "user") {
  return (await readSnapshot(page.request, role)).db;
}
async function login(page: Page, role = "user", username = "lin") {
  const response = await page.request.post("/api/auth/login", {
    headers,
    data: {
      role,
      username,
      password: role === "admin" ? TEST_ADMIN_PASSWORD : TEST_USER_PASSWORD,
    },
  });
  expect(response.ok()).toBe(true);
}
async function coupon(
  page: Page,
  name: string,
  threshold = 100,
  totalLimit = 10,
) {
  await action(page, "saveCoupon", {
    name,
    threshold,
    discount: 1,
    totalLimit,
    active: true,
    claimStartsAt: new Date(Date.now() - 60000).toISOString(),
    claimEndsAt: new Date(Date.now() + 3600000).toISOString(),
    validFrom: new Date(Date.now() - 60000).toISOString(),
    validUntil: new Date(Date.now() + 86400000).toISOString(),
  });
  return (await state(page)).coupons.find(
    (c: { name: string }) => c.name === name,
  );
}
test.beforeEach(async ({ page }) => {
  test.skip(!!process.env.PLAYWRIGHT_BASE_URL, "优惠券体验仅使用隔离夹具");
  await login(page, "admin", "admin");
  await login(page);
});
test("他人领完后用户与游客显示领完，本人已领取优先，后台数量一致", async ({
  page,
  browser,
  baseURL,
}) => {
  const value = await coupon(page, "唯一名额券", 100, 1);
  const otherContext = await browser.newContext({ baseURL }),
    guestContext = await browser.newContext({ baseURL });
  try {
    const other = await otherContext.newPage(),
      guest = await guestContext.newPage();
    await login(other, "user", "chen");
    await action(other, "claimCoupon", value.id);
    await page.goto("/coupons");
    await expect(
      page.getByRole("button", { name: "已领完", exact: true }),
    ).toBeDisabled();
    expect((await state(page)).couponClaims).toEqual([]);
    await guest.goto("/coupons");
    await expect(
      guest.getByRole("button", { name: "已领完", exact: true }),
    ).toBeDisabled();
    await expect(
      guest.getByRole("link", { name: "登录领取", exact: true }),
    ).toHaveCount(0);
    await other.goto("/coupons");
    await expect(
      other.getByRole("button", { name: "已领取", exact: true }),
    ).toBeDisabled();
    await page.goto("/admin/coupons");
    await expect(
      page
        .locator(".el-table__body-wrapper tbody tr")
        .filter({ hasText: value.name }),
    ).toContainText("1 / 1");
  } finally {
    await otherContext.close();
    await guestContext.close();
  }
});
test("门槛差一分禁选且显示差额，恰好达标可用，价格下降后不得静默取消优惠", async ({
  page,
}) => {
  const value = await coupon(page, "门槛边界券", 39901);
  await action(page, "claimCoupon", value.id);
  const claim = (await state(page)).couponClaims[0];
  const originalOrders = (await state(page)).orders;
  await page.goto("/checkout?productId=p01&skuId=p01-s1&quantity=1");
  const select = page.getByLabel("使用优惠券", { exact: true }),
    option = select.locator("option").filter({ hasText: value.name });
  await expect(option).toBeDisabled();
  await expect(
    page.getByText("门槛边界券：未达门槛，还差 ¥0.01", { exact: true }),
  ).toBeVisible();
  await page.goto("/checkout?productId=p01&skuId=p01-s1&quantity=2");
  await expect(option).toBeEnabled();
  await page.goto("/checkout?productId=p01&skuId=p01-s1&quantity=1");
  await expect(option).toBeDisabled();
  const product = (await state(page)).products.find(
    (p: { id: string }) => p.id === "p01",
  );
  await action(page, "saveProduct", {
    ...product,
    skus: product.skus.map((s: { id: string; price: number }) => ({
      ...s,
      price: s.id === "p01-s1" ? 39901 : s.price,
    })),
  });
  await expect(option).toBeEnabled();
  await select.selectOption(claim.id);
  await expect(page.locator(".order-summary .summary-total")).toContainText(
    "¥399.00",
  );
  await expect(
    page.getByRole("button", { name: "提交订单", exact: true }),
  ).toBeEnabled();
  await action(page, "saveProduct", product);
  await expect(option).toBeDisabled();
  await expect(
    page.getByText("门槛边界券：未达门槛，还差 ¥0.01", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("当前选择的优惠券不可用，请取消用券并重新确认报价。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "提交订单", exact: true }),
  ).toBeDisabled();
  await select.selectOption("");
  await expect(
    page.getByRole("button", { name: "提交订单", exact: true }),
  ).toBeEnabled();
  expect((await state(page)).orders).toEqual(originalOrders);
});
test("他人领取同券只更新领取数，不能使已有有效报价失效", async ({
  page,
  browser,
  baseURL,
}) => {
  const value = await coupon(page, "报价稳定券", 100, 2);
  await action(page, "claimCoupon", value.id);
  const claim = (await state(page)).couponClaims[0];
  let quotes = 0;
  await page.route("**/api/actions/quoteCheckout", (route) => {
    quotes++;
    return route.continue();
  });
  await page.goto("/checkout?productId=p01&skuId=p01-s1&quantity=1");
  await page.getByLabel("使用优惠券", { exact: true }).selectOption(claim.id);
  const submit = page.getByRole("button", { name: "提交订单", exact: true });
  await expect(submit).toBeEnabled();
  const before = quotes;
  const beforeRevision = (await state(page)).revision;
  const otherContext = await browser.newContext({ baseURL });
  try {
    const other = await otherContext.newPage();
    await login(other, "user", "chen");
    const synchronized = page.waitForResponse(
      async (response) =>
        response.url().includes("/api/bootstrap?role=user") &&
        response.ok() &&
        (await response.json()).db.revision > beforeRevision,
    );
    await action(other, "claimCoupon", value.id);
    await synchronized;
    const couponPage = await (
      await page.request.get(`/api/collections/coupons?id=${value.id}`)
    ).json();
    expect(couponPage.items[0].claimedCount).toBe(2);
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await expect(submit).toBeEnabled();
    expect(quotes).toBe(before);
    await expect(
      page.getByText(
        "商品、地址、优惠券或购物车已变化，请重新获取报价并确认金额。",
        { exact: true },
      ),
    ).toHaveCount(0);
  } finally {
    await otherContext.close();
  }
});
test("后台四页名称和启停状态筛选、刷新回退及停用后页码收敛", async ({
  page,
}) => {
  test.setTimeout(90000);
  for (let i = 0; i < 31; i++) {
    const value = await coupon(page, `运营券 ${String(i).padStart(2, "0")}`);
    if (i >= 11) await action(page, "toggleCoupon", value.id);
  }
  await page.goto("/admin/coupons?q=运营券");
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
  await page.locator(".admin-toolbar .el-select").click();
  await page.getByRole("option", { name: "已启用", exact: true }).click();
  await expect(rows).toHaveCount(10);
  await expect(page).not.toHaveURL(/page=3/);
  await page.locator(".el-pager li").filter({ hasText: /^2$/ }).click();
  await expect(rows).toHaveCount(1);
  await rows.getByRole("button", { name: "停用", exact: true }).click();
  await expect(page).not.toHaveURL(/page=2/);
  await expect(rows).toHaveCount(10);
  await page.getByPlaceholder("搜索优惠券名称").fill("运营券 00");
  await expect(rows).toHaveCount(1);
  await rows.getByRole("button", { name: "查看配置", exact: true }).click();
  await expect(page).toHaveURL(/detail=/);
  await page.reload();
  await expect(
    page.getByRole("dialog", { name: "优惠券配置", exact: true }),
  ).toBeVisible();
});
test("未领取配置带只读计数仍可编辑，保存失败保留草稿且重试只提交可写字段", async ({
  page,
}) => {
  const value = await coupon(page, "未领取可编辑券");
  await page.goto(`/admin/coupons?detail=${value.id}`);
  const dialog = page.getByRole("dialog", { name: "优惠券配置", exact: true });
  await dialog
    .getByLabel("优惠券名称", { exact: true })
    .fill("修改后的未领取券");
  let count = 0;
  await page.route("**/api/actions/saveCoupon", async (route) => {
    const input = route.request().postDataJSON().args[0];
    expect(input).not.toHaveProperty("claimedCount");
    expect(input.version).toBe(value.version ?? 1);
    expect(Object.keys(input).sort()).toEqual(
      [
        "id",
        "version",
        "name",
        "threshold",
        "discount",
        "claimStartsAt",
        "claimEndsAt",
        "validFrom",
        "validUntil",
        "totalLimit",
        "active",
      ].sort(),
    );
    if (++count === 1)
      await route.fulfill({ status: 400, json: { message: "测试保存拒绝" } });
    else await route.continue();
  });
  await dialog.getByRole("button", { name: "保存优惠券", exact: true }).click();
  await expect(page.getByText("测试保存拒绝", { exact: true })).toBeVisible();
  await expect(dialog.getByLabel("优惠券名称", { exact: true })).toHaveValue(
    "修改后的未领取券",
  );
  await dialog.getByRole("button", { name: "保存优惠券", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const saved = (await state(page, "admin")).coupons.find(
    (c: { id: string }) => c.id === value.id,
  );
  expect(saved).toMatchObject({
    name: "修改后的未领取券",
    claimedCount: 0,
    threshold: 100,
    discount: 1,
  });
  expect(count).toBe(2);
});
