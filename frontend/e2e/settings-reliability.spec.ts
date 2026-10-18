import { test, expect, TEST_ADMIN_PASSWORD } from "./fixtures";
import type { Route } from "@playwright/test";

test.beforeEach(() => {
  test.skip(!!process.env.PLAYWRIGHT_BASE_URL, "仅使用隔离夹具数据库");
});

test("设置草稿跨轮询保留，冲突不会覆盖远端，公告可清空并刷新保持", async ({
  page,
}) => {
  const headers = { "X-ShopMate-Request": "1" };
  await page.request.post("/api/auth/login", {
    headers,
    data: { role: "admin", username: "admin", password: TEST_ADMIN_PASSWORD },
  });
  await page.goto("/admin/settings");
  const name = page.locator(".admin-settings-form input").nth(0);
  const notice = page.locator(".admin-settings-form textarea");
  const original = (
    await (await page.request.get("/api/state?role=admin")).json()
  ).db.settings;
  await name.fill("本地尚未保存的草稿");
  // Wait for two real polling responses rather than a fixed delay.
  for (let i = 0; i < 2; i++) {
    await page.waitForResponse(
      (r) => r.url().includes("/api/bootstrap?") && r.ok(),
    );
  }
  await expect(name).toHaveValue("本地尚未保存的草稿");
  const remote = { ...original, name: "另一个标签页的设置" };
  const saved = await page.request.post("/api/actions/saveSettings", {
    headers,
    data: { args: [remote, original] },
  });
  expect(saved.ok()).toBe(true);
  await expect(
    page.getByRole("alert").filter({ hasText: "其他页面已更新" }),
  ).toBeVisible();
  await expect(name).toHaveValue("本地尚未保存的草稿");
  await page.getByRole("button", { name: "保存信息", exact: true }).click();
  await expect(
    page.getByText("设置已被其他页面修改，请加载最新设置后重新编辑", {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "加载最新设置", exact: true }).click();
  await expect(name).toHaveValue(remote.name);
  await name.fill("最终保存的商城");
  await notice.fill("");
  await page.getByRole("button", { name: "保存信息", exact: true }).click();
  await expect(page.getByText("商城信息已保存", { exact: true })).toBeVisible();
  await page.reload();
  await expect(name).toHaveValue("最终保存的商城");
  await expect(notice).toHaveValue("");
});

test("保存失败后草稿仍可编辑并重新提交", async ({ page }) => {
  await page.request.post("/api/auth/login", {
    headers: { "X-ShopMate-Request": "1" },
    data: { role: "admin", username: "admin", password: TEST_ADMIN_PASSWORD },
  });
  await page.goto("/admin/settings");
  const name = page.locator(".admin-settings-form input").nth(0);
  await name.fill("保存失败后保留");
  await page.route(
    "**/api/actions/saveSettings",
    (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ message: "测试保存失败" }),
      }),
    { times: 1 },
  );
  await page.getByRole("button", { name: "保存信息", exact: true }).click();
  await expect(page.getByText("测试保存失败", { exact: true })).toBeVisible();
  await page.waitForResponse((r) => r.url().includes("/api/bootstrap?") && r.ok());
  await expect(name).toHaveValue("保存失败后保留");
  await page.getByRole("button", { name: "保存信息", exact: true }).click();
  await expect(page.getByText("商城信息已保存", { exact: true })).toBeVisible();
});

test("409 后加载最新值必须等待服务端读取，期间保留草稿", async ({ page }) => {
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  const headers = { "X-ShopMate-Request": "1" };
  await page.request.post("/api/auth/login", {
    headers,
    data: { role: "admin", username: "admin", password: TEST_ADMIN_PASSWORD },
  });
  await page.goto("/admin/settings");
  const baseline = (
    await (await page.request.get("/api/state?role=admin")).json()
  ).db.settings;
  const held: Route[] = [];
  await page.route("**/api/bootstrap?role=admin", (route) => {
    held.push(route);
  });
  const name = page.locator(".admin-settings-form input").nth(0);
  await name.fill("冲突时保留的草稿");
  const remote = { ...baseline, name: "尚未同步的远端设置" };
  expect(
    (
      await page.request.post("/api/actions/saveSettings", {
        headers,
        data: { args: [remote, baseline] },
      })
    ).ok(),
  ).toBe(true);
  await page.getByRole("button", { name: "保存信息", exact: true }).click();
  await expect(
    page.getByText("设置已被其他页面修改，请加载最新设置后重新编辑", {
      exact: true,
    }),
  ).toBeVisible();
  const reload = page.getByRole("button", {
    name: "加载最新设置",
    exact: true,
  });
  await reload.click();
  await expect(reload).toBeDisabled();
  await expect(name).toHaveValue("冲突时保留的草稿");
  await expect.poll(() => held.length).toBe(1);
  // A newer background poll must not discard the manual refresh result.
  await page.clock.runFor(2100);
  await expect.poll(() => held.length).toBeGreaterThanOrEqual(2);
  await held[0]!.continue();
  await expect(name).toHaveValue(remote.name);
  await Promise.all(held.slice(1).map((route) => route.continue()));
  await page.unroute("**/api/bootstrap?role=admin");
});
