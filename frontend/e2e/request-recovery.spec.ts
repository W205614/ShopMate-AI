import { readSnapshot } from "./api-snapshot";
import {
  test,
  expect,
  TEST_ADMIN_PASSWORD,
  TEST_USER_PASSWORD,
} from "./fixtures";
test.beforeEach(() => {
  test.skip(!!process.env.PLAYWRIGHT_BASE_URL, "故障注入仅使用隔离夹具");
});
const headers = { "X-ShopMate-Request": "1" };

test("后台提交已成功但状态读取失败，保留成功结果并允许重新同步", async ({
  page,
}) => {
  await page.request.post("/api/auth/login", {
    headers,
    data: { role: "admin", username: "admin", password: TEST_ADMIN_PASSWORD },
  });
  await page.goto("/admin/settings");
  let blocked = false,
    writes = 0;
  await page.route("**/api/bootstrap?role=admin", (route) =>
    blocked
      ? route.fulfill({ status: 503, json: { message: "测试同步不可用" } })
      : route.continue(),
  );
  await page.route("**/api/actions/saveSettings", async (route) => {
    writes++;
    const response = await route.fetch();
    blocked = true;
    await route.fulfill({ response });
  });
  await page.locator(".admin-settings-form input").first().fill("提交已经成功");
  await page.getByRole("button", { name: "保存信息", exact: true }).click();
  await expect(page.getByText("商城信息已保存", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("alert").filter({ hasText: "操作已完成" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "保存信息", exact: true }),
  ).toBeDisabled();
  expect(writes).toBe(1);
  blocked = false;
  await page.getByRole("button", { name: "重新连接", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "保存信息", exact: true }),
  ).toBeEnabled();
  await expect(page.locator(".admin-settings-form input").first()).toHaveValue(
    "提交已经成功",
  );
  expect(writes).toBe(1);
});

test("首次读取故障保留目标 URL，恢复后才根据真实会话显示订单或登录", async ({
  page,
}) => {
  await page.request.post("/api/auth/login", {
    headers,
    data: { role: "user", username: "lin", password: TEST_USER_PASSWORD },
  });
  let blocked = true;
  await page.route("**/api/bootstrap?role=user", (route) =>
    blocked ? route.abort() : route.continue(),
  );
  await page.goto("/orders");
  await expect(page).toHaveURL(/\/orders$/);
  await expect(
    page.getByRole("heading", { name: "暂时无法连接服务", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".order-block")).toHaveCount(0);
  blocked = false;
  await page.getByRole("button", { name: "重新连接", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "我的订单", exact: true }),
  ).toBeVisible();
  await page.request.post("/api/auth/logout", {
    headers,
    data: { role: "user" },
  });
  blocked = true;
  await page.reload();
  await expect(page).toHaveURL(/\/orders$/);
  blocked = false;
  await page.getByRole("button", { name: "重新连接", exact: true }).click();
  await expect(page).toHaveURL(/\/login\?redirect=\/orders/);
});

test("写入后响应丢失显示结果未知，不自动重发", async ({ page }) => {
  await page.request.post("/api/auth/login", {
    headers,
    data: { role: "user", username: "lin", password: TEST_USER_PASSWORD },
  });
  await page.goto("/products/p01");
  const before = (await readSnapshot(page.request, "user")).db.carts
    .filter(
      (c: { userId: string; skuId: string }) =>
        c.userId === "u1" && c.skuId === "p01-s1",
    )
    .reduce((n: number, c: { quantity: number }) => n + c.quantity, 0);
  let writes = 0;
  await page.route("**/api/actions/addCart", async (route) => {
    writes++;
    expect((await route.fetch()).ok()).toBe(true);
    await route.abort();
  });
  await page.getByRole("button", { name: "加入购物车", exact: false }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "结果暂无法确认" }),
  ).toBeVisible();
  await page.waitForResponse((r) => r.url().includes("/api/bootstrap?") && r.ok());
  expect(writes).toBe(1);
  const after = (
    await readSnapshot(page.request, "user")
  ).db.carts.find(
    (c: { userId: string; skuId: string }) =>
      c.userId === "u1" && c.skuId === "p01-s1",
  );
  expect(after.quantity).toBe(before + 1);
});

test("用户加购成功后同步中断仍显示成功，重新连接不重复加购", async ({
  page,
}) => {
  await page.request.post("/api/auth/login", {
    headers,
    data: { role: "user", username: "lin", password: TEST_USER_PASSWORD },
  });
  await page.goto("/products/p01");
  let blocked = false,
    writes = 0;
  await page.route("**/api/bootstrap?role=user", (route) =>
    blocked ? route.abort() : route.continue(),
  );
  await page.route("**/api/actions/addCart", async (route) => {
    writes++;
    const response = await route.fetch();
    blocked = true;
    await route.fulfill({ response });
  });
  const add = page.getByRole("button", { name: "加入购物车", exact: false });
  await add.click();
  await expect(
    page.getByRole("status").filter({ hasText: "已加入购物车" }),
  ).toBeVisible();
  await expect(add).toBeDisabled();
  expect(writes).toBe(1);
  blocked = false;
  await page.getByRole("button", { name: "重新连接", exact: true }).click();
  await expect(add).toBeEnabled();
  expect(writes).toBe(1);
});

test("管理端切换商城时读取故障不会展示旧管理快照", async ({ page }) => {
  await page.request.post("/api/auth/login", {
    headers,
    data: { role: "admin", username: "admin", password: TEST_ADMIN_PASSWORD },
  });
  await page.goto("/admin/finance");
  await expect(
    page.getByRole("heading", { name: "收支流水", exact: true }),
  ).toBeVisible();
  let blocked = true;
  await page.route("**/api/bootstrap?role=user", (route) =>
    blocked ? route.abort() : route.continue(),
  );
  await page.getByRole("link", { name: /前往商城/ }).click();
  await expect(
    page.getByRole("heading", { name: "暂时无法连接服务", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".admin-app")).toHaveCount(0);
  await expect(page.getByText("初始演示订单收款")).toHaveCount(0);
  blocked = false;
  await page.getByRole("button", { name: "重新连接", exact: true }).click();
  await expect(page.locator(".shop-site")).toBeVisible();
  await expect(page.locator(".admin-app")).toHaveCount(0);
});

test("游客已加载公开目录后连接中断，受保护页面仍保持隐藏", async ({ page }) => {
  await page.goto("/products");
  await expect(page.locator(".product-grid")).toBeVisible();
  await page.route("**/api/bootstrap?role=user", (route) => route.abort());
  await page.getByRole("link", { name: "我的订单", exact: true }).click();
  await expect(page).toHaveURL(/\/orders$/);
  await expect(
    page.getByRole("heading", { name: "暂时无法连接服务", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "我的订单", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".order-block")).toHaveCount(0);
});
