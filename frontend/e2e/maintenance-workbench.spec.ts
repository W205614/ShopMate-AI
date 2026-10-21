import { resolve } from "node:path";
import { openDatabase } from "../../backend/src/database";
import { test, expect, TEST_ADMIN_PASSWORD } from "./fixtures";

const headers = { "X-ShopMate-Request": "1" };
test.beforeEach(() => {
  test.skip(
    !!process.env.PLAYWRIGHT_BASE_URL &&
      process.env.E2E_MAINTENANCE_FIXTURE !== "1",
    "外部部署需要明确准备独立维护验收任务，禁止写入日常部署",
  );
});

test("店主按需查看运行状态、分页失败任务，丢响应后核对原请求而不重复重排", async ({
  page,
}) => {
  if (!process.env.PLAYWRIGHT_BASE_URL) {
    const sql = openDatabase(resolve("../backend/.e2e/shopmate.sqlite"));
    try {
      const insert = sql.prepare(
        "INSERT INTO job_queue(id,kind,payload,status,attempts,run_after,last_error,created_at) VALUES (?,'notification',?,'failed',5,?,'JOB_EXECUTION_FAILED',?)",
      );
      for (let i = 0; i < 25; i++) {
        insert.run(
          `maintenance-${String(i).padStart(3, "0")}`,
          JSON.stringify({ userId: "u1", text: "隔离维护验收通知" }),
          Date.now(),
          new Date(Date.now() + i * 1000).toISOString(),
        );
      }
    } finally {
      sql.close();
    }
  }
  const login = await page.request.post("/api/auth/login", {
    headers,
    data: { role: "admin", username: "admin", password: TEST_ADMIN_PASSWORD },
  });
  expect(login.ok()).toBe(true);
  let diagnosticReads = 0;
  page.on("request", (r) => {
    if (r.url().endsWith("/api/admin/diagnostics")) diagnosticReads++;
  });
  await page.goto("/admin/operations?tab=runtime");
  const runtime = page.getByRole("region", { name: "运行状态", exact: true });
  await expect(runtime).toContainText("运行提交");
  await expect(runtime).toContainText("备份恢复点");
  await expect(runtime).toContainText("北京时间");
  expect(diagnosticReads).toBe(1);
  // Existing bootstrap refreshes must not trigger another expensive diagnostics read.
  for (let i = 0; i < 2; i++)
    await page.waitForResponse(
      (r) => r.url().includes("/api/bootstrap?") && r.ok(),
    );
  expect(diagnosticReads).toBe(1);
  await runtime
    .getByRole("button", { name: "刷新运行状态", exact: true })
    .click();
  await expect.poll(() => diagnosticReads).toBe(2);
  await page.getByRole("button", { name: "后台任务", exact: true }).click();
  const tasks = page.getByRole("region", { name: "后台任务", exact: true });
  await tasks.getByLabel("任务状态", { exact: true }).selectOption("failed");
  await expect(tasks).toContainText("共 25 条");
  await tasks.getByRole("listitem", { name: "第 2 页", exact: true }).click();
  await expect(tasks.locator(".el-table__body-wrapper")).toContainText(
    "maintenance-000",
  );
  await tasks.getByRole("listitem", { name: "第 1 页", exact: true }).click();
  const row = tasks
    .locator(".el-table__body-wrapper tr")
    .filter({ hasText: "maintenance-024" });
  await expect(row).toContainText("站内通知");
  await expect(row).toContainText("已失败");
  let retryPosts = 0;
  await page.route("**/api/actions/retryJob", async (route) => {
    retryPosts++;
    const response = await route.fetch();
    expect(response.ok(), await response.text()).toBe(true);
    await route.abort("failed");
  });
  await row.getByRole("button", { name: "重试任务", exact: true }).click();
  await page.getByRole("button", { name: "确认重试", exact: true }).click();
  await expect(tasks).toContainText("上次重试结果需要核对");
  await tasks
    .getByRole("button", { name: "核对上次请求", exact: true })
    .click();
  await expect(tasks).not.toContainText("上次重试结果需要核对");
  await expect(tasks).toContainText("共 24 条");
  expect(retryPosts).toBe(1);
  const list = await (
    await page.request.get("/api/admin/jobs?status=all&page=1&pageSize=100")
  ).json();
  expect(
    list.items.find((item: { id: string }) => item.id === "maintenance-024")
      ?.retryVersion,
  ).toBe(1);
  const audit = await (
    await page.request.get(
      "/api/collections/auditEntries?role=admin&pageSize=100",
    )
  ).json();
  const matching = audit.items.filter(
    (item: { action: string; objectId: string; result: string }) =>
      item.action === "retryJob" &&
      item.objectId === "maintenance-024" &&
      JSON.parse(item.result).status === "rescheduled",
  );
  expect(matching).toHaveLength(1);
});

test("运营账号不能查看运行状态或后台任务，也不能提交重试", async ({ page }) => {
  const username = `maintenance_${crypto.randomUUID().slice(0, 8)}`;
  await page.request.post("/api/auth/login", {
    headers,
    data: { role: "admin", username: "admin", password: TEST_ADMIN_PASSWORD },
  });
  const staff = await page.request.post("/api/actions/saveStaff", {
    headers,
    data: {
      args: [
        {
          username,
          name: "维护权限验收",
          password: "RoleStaff123!",
          staffRole: "operations",
          active: true,
        },
      ],
      requestId: crypto.randomUUID(),
    },
  });
  expect(staff.ok(), await staff.text()).toBe(true);
  await page.request.post("/api/auth/logout", {
    headers,
    data: { role: "admin" },
  });
  const login = await page.request.post("/api/auth/login", {
    headers,
    data: {
      role: "admin",
      username,
      password: "RoleStaff123!",
    },
  });
  expect(login.ok()).toBe(true);
  await page.goto("/admin/operations?tab=runtime");
  await expect(
    page.getByText("当前角色没有该工作区权限，请选择可用功能。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "运行状态", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "后台任务", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "运行状态", exact: true }),
  ).toHaveCount(0);
  expect((await page.request.get("/api/admin/diagnostics")).status()).toBe(403);
  expect(
    (
      await page.request.get("/api/admin/jobs?status=failed&page=1&pageSize=20")
    ).status(),
  ).toBe(403);
  expect(
    (
      await page.request.post("/api/actions/retryJob", {
        headers,
        data: { args: ["maintenance-024", 0], requestId: crypto.randomUUID() },
      })
    ).status(),
  ).toBe(403);
});
