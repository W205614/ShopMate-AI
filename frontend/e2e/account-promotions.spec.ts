import type { Page } from "@playwright/test";
import {
  test,
  expect,
  TEST_USER_PASSWORD,
  TEST_ADMIN_PASSWORD,
} from "./fixtures";

async function login(page: Page, admin = false, password = TEST_USER_PASSWORD) {
  await page.goto(admin ? "/admin/login" : "/login");
  await page.getByLabel("账号", { exact: true }).fill(admin ? "admin" : "lin");
  await page
    .getByLabel("密码", { exact: true })
    .fill(admin ? TEST_ADMIN_PASSWORD : password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(admin ? /\/admin$/ : /\/$/);
}

test.beforeEach(() => {
  test.skip(
    !!process.env.PLAYWRIGHT_BASE_URL &&
      process.env.E2E_MUTATIONS_ALLOWED !== "1",
    "写入式测试仅在夹具数据库或显式允许的隔离部署运行",
  );
});

test("昵称修改可持久化，改密撤销所有用户会话并保留管理员登录", async ({
  page,
  context,
  browser,
  baseURL,
}) => {
  await login(page);
  const otherContext = await browser.newContext({ baseURL });
  try {
    const otherDevice = await otherContext.newPage();
    const management = await context.newPage();
    // Auxiliary sessions exercise revocation; the primary login and both
    // password re-login attempts below still go through the real form.
    for (const [device, role, username, password] of [
      [otherDevice, "user", "lin", TEST_USER_PASSWORD],
      [management, "admin", "admin", TEST_ADMIN_PASSWORD],
    ] as const) {
      const response = await device.request.post("/api/auth/login", {
        headers: { "X-ShopMate-Request": "1" },
        data: { role, username, password },
      });
      expect(response.ok(), await response.text()).toBe(true);
    }
    await management.goto("/admin");
    const adminCookie = (await context.cookies()).find(
      (cookie) => cookie.name === "shopmate_admin",
    )!.value;

    await page.goto("/account?section=profile");
    await page.getByLabel("昵称", { exact: true }).fill("更新后的昵称");
    await page.getByRole("button", { name: "保存昵称", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("昵称已更新");
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "更新后的昵称，你好。" }),
    ).toBeVisible();
    await expect(page.getByLabel("账号", { exact: true })).toBeDisabled();
    await otherDevice.goto("/account");
    await expect(
      otherDevice.getByRole("heading", { name: "更新后的昵称，你好。" }),
    ).toBeVisible();

    await page.getByRole("button", { name: "账号安全", exact: true }).click();
    await page.getByLabel("原密码", { exact: true }).fill("WrongPassword123");
    await page
      .getByLabel("新密码", { exact: true })
      .fill("ChangedPassword123!");
    await page
      .getByLabel("确认新密码", { exact: true })
      .fill("ChangedPassword123!");
    await page
      .getByRole("button", { name: "修改密码并重新登录", exact: true })
      .click();
    await expect(page.getByRole("alert")).toContainText("原密码错误");
    await page.getByLabel("原密码", { exact: true }).fill(TEST_USER_PASSWORD);
    await page
      .getByRole("button", { name: "修改密码并重新登录", exact: true })
      .click();
    await expect(page).toHaveURL(/\/login\?.*changed=1/);
    await expect(page.getByRole("status")).toContainText("密码已修改");
    await otherDevice.goto("/account");
    await expect(otherDevice).toHaveURL(/\/login\?redirect=\/account/);
    expect(
      (await context.cookies()).find(
        (cookie) => cookie.name === "shopmate_admin",
      )?.value,
    ).toBe(adminCookie);
    await management.reload();
    await expect(
      management.getByRole("heading", { name: "经营概览", exact: true }),
    ).toBeVisible();

    await page.getByLabel("账号", { exact: true }).fill("lin");
    await page.getByLabel("密码", { exact: true }).fill(TEST_USER_PASSWORD);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("账号或密码错误");
    await page.getByLabel("密码", { exact: true }).fill("ChangedPassword123!");
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(page).toHaveURL(/\/account\?section=security$/);
  } finally {
    await otherContext.close();
  }
});

test("下架收藏提示可移除且刷新后不再出现", async ({ page, context }) => {
  await login(page);
  const favorite = await page.request.post("/api/actions/favorite", {
    headers: { "X-ShopMate-Request": "1" },
    data: { args: ["p02"] },
  });
  expect(favorite.ok()).toBe(true);
  const management = await context.newPage();
  await login(management, true);
  const toggle = await management.request.post("/api/actions/toggleProduct", {
    headers: { "X-ShopMate-Request": "1" },
    data: { args: ["p02"] },
  });
  expect(toggle.ok()).toBe(true);
  await page.goto("/account");
  const unavailable = page
    .locator(".favorite-entry")
    .filter({ hasText: "商品已下架" });
  await expect(unavailable).toHaveCount(1);
  await unavailable.getByRole("button", { name: /取消收藏/ }).click();
  await expect(page.getByRole("status")).toContainText("已取消收藏");
  await page.reload();
  await expect(page.getByText("商品已下架，暂不可购买")).toHaveCount(0);
});

test("后台创建满减券、用户领取、订单占用与取消释放、领取后配置锁定", async ({
  page,
  context,
}) => {
  await login(page, true);
  await page.goto("/admin/coupons");
  await page.getByRole("button", { name: "创建优惠券", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "创建优惠券", exact: true });
  await dialog
    .getByLabel("优惠券名称", { exact: true })
    .fill("日常好物满百减十");
  await dialog.getByRole("button", { name: "保存优惠券", exact: true }).click();
  const row = page
    .locator(".el-table__body-wrapper tbody tr")
    .filter({ hasText: "日常好物满百减十" });
  await expect(row).toContainText("0 / 100");
  const customer = await context.newPage();
  await login(customer);
  await customer.goto("/coupons");
  const coupon = customer
    .locator(".commerce-coupon")
    .filter({ hasText: "日常好物满百减十" });
  await coupon.getByRole("button", { name: "立即领取", exact: true }).click();
  await expect(
    coupon.getByRole("button", { name: "已领取", exact: true }),
  ).toBeDisabled();
  await customer.goto("/account?section=coupons");
  await expect(customer.locator(".commerce-coupon")).toContainText("可使用");
  const state = await (
    await customer.request.get("/api/state?role=user")
  ).json();
  const claimId = state.db.couponClaims[0].id;
  const quoteResponse = await customer.request.post(
    "/api/actions/quoteCheckout",
    {
      headers: { "X-ShopMate-Request": "1" },
      data: {
        args: [
          {
            source: {
              type: "buyNow",
              productId: "p01",
              skuId: state.db.products.find(
                (p: { id: string }) => p.id === "p01",
              ).skus[0].id,
              quantity: 1,
            },
            addressId: "a1",
            couponClaimId: claimId,
          },
        ],
      },
    },
  );
  expect(quoteResponse.ok()).toBe(true);
  const quoteId = (await quoteResponse.json()).result.id;
  const orderResponse = await customer.request.post(
    "/api/actions/createOrder",
    {
      headers: { "X-ShopMate-Request": "1" },
      data: { args: [{ quoteId, requestId: "coupon-ui-order" }] },
    },
  );
  expect(orderResponse.ok()).toBe(true);
  const orderId = (await orderResponse.json()).result;
  await customer.reload();
  await expect(customer.locator(".commerce-coupon")).toContainText(
    "订单占用中",
  );
  const cancel = await customer.request.post("/api/actions/cancelOrder", {
    headers: { "X-ShopMate-Request": "1" },
    data: { args: [orderId] },
  });
  expect(cancel.ok()).toBe(true);
  await customer.reload();
  await expect(customer.locator(".commerce-coupon")).toContainText("可使用");
  await page.reload();
  await expect(row).toContainText("1 / 100");
  await row.getByRole("button", { name: "查看配置", exact: true }).click();
  const config = page.getByRole("dialog", { name: "优惠券配置", exact: true });
  await expect(config.getByLabel("优惠券名称", { exact: true })).toBeDisabled();
  await expect(config.getByText(/已有领取记录，配置已锁定/)).toBeVisible();
  await config.getByRole("button", { name: "关闭", exact: true }).click();
  await row.getByRole("button", { name: "停用", exact: true }).click();
  await expect(row).toContainText("已停用");
  await customer.reload();
  await expect(customer.locator(".commerce-coupon")).toContainText("已停用");
});

test("购买后评价公开脱敏，后台隐藏恢复及用户删除影响公开评分", async ({
  page,
  context,
}) => {
  await login(page);
  await page.goto("/orders/SM000001");
  await page.getByRole("link", { name: "评价商品", exact: true }).click();
  await expect(page).toHaveURL(
    /\/account\?section=pending-reviews&orderId=SM000001$/,
  );
  const eligible = page
    .locator(".commerce-list-card")
    .filter({ hasText: "SM000001" });
  await eligible.getByRole("button", { name: "写评价", exact: true }).click();
  await eligible.getByLabel("评分", { exact: true }).selectOption("4");
  await eligible
    .getByLabel("评价内容", { exact: true })
    .fill("外观简洁，日常使用体验很好。");
  await eligible.getByRole("button", { name: "发布评价", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("评价已发布");
  await expect(
    page.locator(".commerce-list-card").filter({ hasText: "SM000001" }),
  ).toHaveCount(0);
  await page.goto("/products/p01");
  const reviews = page.getByRole("region", { name: "商品评价", exact: true });
  await expect(reviews).toContainText("外观简洁，日常使用体验很好。");
  await expect(reviews).toContainText("林**");
  await expect(reviews).toContainText("4.0 / 5 星");
  const publicData = await (
    await page.request.get("/api/products/p01/reviews?page=1")
  ).json();
  expect(Object.keys(publicData.items[0]).sort()).toEqual([
    "content",
    "createdAt",
    "displayName",
    "id",
    "rating",
  ]);

  const management = await context.newPage();
  await login(management, true);
  await management.goto("/admin/reviews");
  const row = management
    .locator(".el-table__body-wrapper tbody tr")
    .filter({ hasText: "外观简洁，日常使用体验很好。" });
  await row.getByRole("button", { name: "隐藏评价", exact: true }).click();
  await expect(row).toContainText("已隐藏");
  await expect(
    reviews.getByText("外观简洁，日常使用体验很好。", { exact: true }),
  ).toHaveCount(0);
  await expect(reviews).toContainText("0 条评价");
  await row.getByRole("button", { name: "恢复展示", exact: true }).click();
  await expect(reviews).toContainText("外观简洁，日常使用体验很好。");
  await page.goto("/account?section=reviews");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "删除评价", exact: true }).click();
  await expect(page.locator(".commerce-list-card")).toContainText("已删除");
  await page.goto("/products/p01");
  await expect(
    page.getByRole("region", { name: "商品评价", exact: true }),
  ).toContainText("0 条评价");
  await management.reload();
  await expect(row).toContainText("用户已删除");
  await expect(
    row.getByRole("button", { name: "恢复展示", exact: true }),
  ).toHaveCount(0);
});

test("新增账号、优惠券及评价页面在桌面平板手机可刷新且无溢出", async ({
  page,
}) => {
  test.setTimeout(90000);
  await login(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of [
      "/coupons",
      "/account?section=profile",
      "/account?section=security",
      "/account?section=coupons",
      "/account?section=pending-reviews",
      "/account?section=reviews",
    ]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await page.reload();
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth + 1,
        ),
        `${path} @${width}`,
      ).toBe(true);
    }
  }
  await login(page, true);
  for (const path of ["/admin/coupons", "/admin/reviews"]) {
    await page.goto(path);
    await page.reload();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    ).toBe(true);
  }
  expect(errors).toEqual([]);
});
