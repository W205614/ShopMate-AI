import type { Page } from "@playwright/test";
import {
  test,
  expect,
  TEST_ADMIN_PASSWORD,
  TEST_USER_PASSWORD,
} from "./fixtures";

const headers = { "X-ShopMate-Request": "1" };
async function login(page: Page, role: "user" | "admin" = "user") {
  const response = await page.request.post("/api/auth/login", {
    headers,
    data: {
      role,
      username: role === "user" ? "lin" : "admin",
      password: role === "user" ? TEST_USER_PASSWORD : TEST_ADMIN_PASSWORD,
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
}
async function action(page: Page, method: string, ...args: unknown[]) {
  const response = await page.request.post(`/api/actions/${method}`, {
    headers,
    data: { args },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).result;
}
async function conversation(page: Page, id: string) {
  const state = await (await page.request.get("/api/state?role=user")).json();
  return state.db.conversations.find((item: { id: string }) => item.id === id);
}
test.beforeEach(async ({ page }) => {
  test.skip(!!process.env.PLAYWRIGHT_BASE_URL, "客服体验回归仅使用隔离夹具");
  await login(page);
});

async function expiringProposal(page: Page) {
  const id = await action(page, "createConversation", { productId: "p01" }),
    chat = await conversation(page, id),
    expiresAt = new Date(Date.now() + 60_000).toISOString();
  let reads = 0,
    mutations = 0;
  await page.route(`**/api/support/conversations/${id}`, (route) => {
    reads++;
    return route.fulfill({
      json: {
        conversation: chat,
        aiEnabled: true,
        run: { id: "finished-run", status: "completed", phase: "completed" },
        proposals: [
          {
            id: "expiring-proposal",
            kind: "addCart",
            summary: "合成测试商品 · 标准款 × 1",
            details: { quantity: 1, price: 2000, stock: 5 },
            status: "pending",
            expiresAt,
          },
        ],
      },
    });
  });
  await page.route("**/api/actions/*SupportProposal", (route) => {
    mutations++;
    return route.fulfill({ json: { result: null } });
  });
  await page.goto(`/support?conversationId=${id}`);
  await expect(
    page.locator(".message-assistant .message-author").first(),
  ).toHaveText("客服提示");
  await expect(
    page.getByRole("button", { name: "确认加购", exact: true }),
  ).toBeVisible();
  return { reads: () => reads, mutations: () => mutations };
}

test("生成完成后提案按时过期，无需刷新或轮询，不再提供执行按钮", async ({
  page,
}) => {
  await page.clock.install();
  const counters = await expiringProposal(page),
    initialReads = counters.reads();
  await page.clock.fastForward(60_001);
  await expect(page.locator(".support-proposal")).toContainText(
    "已失效，请重新咨询",
  );
  await expect(
    page.getByRole("button", { name: "确认加购", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "不执行", exact: true }),
  ).toHaveCount(0);
  expect(counters.reads()).toBe(initialReads);
  expect(counters.mutations()).toBe(0);
});

test("计时器尚未执行时点击已到期确认，客户端直接阻止请求", async ({ page }) => {
  await page.clock.install();
  const counters = await expiringProposal(page);
  await page.clock.setSystemTime(new Date(Date.now() + 120_000));
  await page.getByRole("button", { name: "确认加购", exact: true }).click();
  await expect(
    page.getByText("操作提案已失效，请重新咨询确认。", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".support-proposal")).toContainText(
    "已失效，请重新咨询",
  );
  expect(counters.mutations()).toBe(0);
});

test("失败后转人工隐藏重试，用户可继续补充并收到人工回复，关闭后不再重试", async ({
  page,
  context,
}) => {
  const id = await action(page, "createConversation", { productId: "p01" });
  let retries = 0;
  await page.route(`**/api/support/conversations/${id}`, async (route) =>
    route.fulfill({
      json: {
        conversation: await conversation(page, id),
        aiEnabled: true,
        run: {
          id: "failed-run",
          status: "failed",
          phase: "failed",
          error: "AI_PROVIDER_FAILED",
        },
        proposals: [],
      },
    }),
  );
  page.on("request", (request) => {
    if (request.url().includes("/api/actions/retrySupportRun")) retries++;
  });
  await page.goto(`/support?conversationId=${id}`);
  await expect(
    page.getByRole("button", { name: "重试本轮", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "转人工", exact: true }).click();
  await expect(page.locator(".chat-header")).toContainText("等待人工接入");
  await expect(
    page.getByRole("button", { name: "重试本轮", exact: true }),
  ).toHaveCount(0);
  await page
    .getByLabel("输入咨询内容", { exact: true })
    .fill("补充说明：请人工核对商品规格");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.locator(".message-user").last()).toContainText(
    "请人工核对商品规格",
  );
  const admin = await context.newPage();
  await login(admin, "admin");
  await action(
    admin,
    "replyConversation",
    id,
    "人工已核对，请参考商品详情的规格信息。",
  );
  await expect(page.locator(".message-agent").last()).toContainText(
    "人工已核对",
  );
  await expect(page.locator(".chat-header")).toContainText("人工服务中");
  await action(admin, "closeConversation", id);
  await expect(page.locator(".chat-closed")).toContainText("会话已结束");
  await expect(
    page.getByRole("button", { name: "重试本轮", exact: true }),
  ).toHaveCount(0);
  expect(retries).toBe(0);
  await admin.close();
});

test("甲会话确认结果迟到不向乙泄露成功或错误，返回甲保留执行结果", async ({
  page,
}) => {
  const a = await action(page, "createConversation", { productId: "p01" }),
    b = await action(page, "createConversation", { productId: "p02" }),
    first = await conversation(page, a),
    second = await conversation(page, b);
  let failed = false,
    completed = false,
    submissions = 0,
    release!: () => void,
    observed!: () => void,
    gate: Promise<void>;
  await page.route(`**/api/support/conversations/${a}`, (route) =>
    route.fulfill({
      json: {
        conversation: first,
        aiEnabled: true,
        run: { id: "scope-run", status: "completed", phase: "completed" },
        proposals: [
          {
            id: failed ? "failed-scope-proposal" : "completed-scope-proposal",
            kind: "addCart",
            summary: "仅属于甲会话的加购操作",
            details: { quantity: 1 },
            status: !failed && completed ? "confirmed" : "pending",
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
          },
        ],
      },
    }),
  );
  await page.route(`**/api/support/conversations/${b}`, (route) =>
    route.fulfill({
      json: { conversation: second, aiEnabled: true, run: null, proposals: [] },
    }),
  );
  await page.route("**/api/actions/confirmSupportProposal", async (route) => {
    submissions++;
    expect(route.request().postDataJSON().args).toEqual([
      failed ? "failed-scope-proposal" : "completed-scope-proposal",
    ]);
    if (!failed) completed = true;
    observed();
    await gate;
    await route.fulfill(
      failed
        ? { status: 409, json: { message: "仅属于甲会话的确认失败" } }
        : { json: { result: { completed: true } } },
    );
  });
  for (const failure of [false, true]) {
    failed = failure;
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen = new Promise<void>((resolve) => {
      observed = resolve;
    });
    await page.goto(`/support?conversationId=${a}`);
    await page.getByRole("button", { name: "确认加购", exact: true }).click();
    await seen;
    await page
      .locator(".conversation-list button")
      .filter({ hasText: second.title })
      .click();
    await expect(page.locator(".chat-header h2")).toHaveText(second.title);
    await page
      .getByLabel("输入咨询内容", { exact: true })
      .fill("乙会话尚未发送的草稿");
    release();
    await expect(
      page.getByRole("button", { name: "转人工", exact: true }),
    ).toBeEnabled();
    await expect(
      page.locator(".chat-panel .action-notice, .chat-panel .action-error"),
    ).toHaveCount(0);
    await expect(page.getByLabel("输入咨询内容", { exact: true })).toHaveValue(
      "乙会话尚未发送的草稿",
    );
    if (!failure) {
      await page
        .locator(".conversation-list button")
        .filter({ hasText: first.title })
        .click();
      await expect(page.locator(".support-proposal")).toContainText("已执行");
      await expect(
        page.getByRole("button", { name: "确认加购", exact: true }),
      ).toHaveCount(0);
    }
  }
  expect(submissions).toBe(2);
  expect(completed).toBe(true);
});
