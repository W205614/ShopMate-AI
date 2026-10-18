import type { Page } from "@playwright/test";
import {
  test,
  expect,
  TEST_USER_PASSWORD,
  TEST_ADMIN_PASSWORD,
} from "./fixtures";

const headers = { "X-ShopMate-Request": "1" };
async function login(page: Page, role: "user" | "admin" = "user") {
  const result = await page.request.post("/api/auth/login", {
    headers,
    data: {
      role,
      username: role === "user" ? "lin" : "admin",
      password: role === "user" ? TEST_USER_PASSWORD : TEST_ADMIN_PASSWORD,
    },
  });
  expect(result.ok()).toBe(true);
}
async function createChat(page: Page, productId = "p01") {
  const response = await page.request.post("/api/actions/createConversation", {
    headers,
    data: { args: [{ productId }] },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()).result as string;
}
async function chatRecord(page: Page, id: string) {
  const state = await (await page.request.get("/api/state?role=user")).json();
  return state.db.conversations.find((c: { id: string }) => c.id === id);
}
test.beforeEach(async () => {
  test.skip(
    !!process.env.PLAYWRIGHT_BASE_URL,
    "AI 合约浏览器测试仅在隔离夹具运行",
  );
});

test("无会话和上下文时首次发送以空参数创建咨询，再保存并回复消息", async ({
  page,
}) => {
  await login(page);
  let creations = 0;
  await page.route("**/api/actions/createConversation", (route) => {
    creations++;
    expect(route.request().postDataJSON().args).toEqual([]);
    return route.continue();
  });
  await page.goto("/support");
  await page.getByLabel("输入咨询内容", { exact: true }).fill("配送需要多久？");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.locator(".message-user")).toContainText("配送需要多久？");
  await expect(page.locator(".message-assistant").last()).toBeVisible();
  await expect(page.getByLabel("输入咨询内容", { exact: true })).toHaveValue(
    "",
  );
  await expect(page.locator(".conversation-list button")).toHaveCount(2);
  expect(creations).toBe(1);
});

test("活跃任务刷新恢复，来源可核对，卡片只在明确确认后提交", async ({
  page,
}) => {
  await login(page);
  const id = await createChat(page),
    conversation = await chatRecord(page, id);
  let completed = false,
    confirmed = false,
    posted = 0;
  await page.route("**/api/support/config", (route) =>
    route.fulfill({ json: { aiEnabled: true } }),
  );
  await page.route(`**/api/support/conversations/${id}`, (route) =>
    route.fulfill({
      json: {
        conversation: {
          ...conversation,
          messages: [
            ...conversation.messages,
            ...(completed
              ? [
                  {
                    id: "answer",
                    role: "assistant",
                    source: "ai",
                    text: "已找到商品，请确认加购数量。",
                    createdAt: new Date().toISOString(),
                    citations: [
                      {
                        id: "d1:1",
                        title: "合成配送说明",
                        text: "预计三天发出；不支持自动付款。",
                        page: 2,
                      },
                    ],
                  },
                ]
              : []),
          ],
        },
        aiEnabled: true,
        run: {
          id: "run-1",
          status: completed ? "completed" : "running",
          phase: "retrieving",
        },
        proposals: completed
          ? [
              {
                id: "proposal-1",
                kind: "addCart",
                summary: "合成测试商品 · 标准款 × 2 · 单价 ¥20.00",
                details: { quantity: 2 },
                status: confirmed ? "confirmed" : "pending",
                expiresAt: new Date(Date.now() + 600000).toISOString(),
              },
            ]
          : [],
      },
    }),
  );
  await page.route("**/api/actions/confirmSupportProposal", (route) => {
    posted++;
    expect(route.request().postDataJSON().args).toEqual(["proposal-1"]);
    expect(route.request().postDataJSON().requestId).toBeTruthy();
    confirmed = true;
    return route.fulfill({ json: { result: { summary: "已加购" } } });
  });
  await page.goto(`/support?conversationId=${id}`);
  await expect(page.getByRole("status")).toContainText("检索中");
  await page.reload();
  await expect(page.getByRole("status")).toContainText("检索中");
  completed = true;
  await expect(
    page.getByText("已找到商品，请确认加购数量。", { exact: true }),
  ).toBeVisible();
  await page.getByText("查看 1 条知识来源").click();
  await expect(page.locator(".support-citations")).toContainText("第 2 页");
  await expect(page.locator(".support-citations")).toContainText(
    "不支持自动付款",
  );
  expect(posted).toBe(0);
  await page.getByRole("button", { name: "确认加购", exact: true }).click();
  await expect(page.locator(".support-proposal")).toContainText("已执行");
  await expect(
    page.getByRole("button", { name: "确认加购", exact: true }),
  ).toHaveCount(0);
  expect(posted).toBe(1);
  // Completed task stops the dedicated poll; page bootstrap remains independent.
  let detailReads = 0;
  page.on("request", (request) => {
    if (request.url().includes(`/api/support/conversations/${id}`))
      detailReads++;
  });
  await page.waitForTimeout(1800);
  expect(detailReads).toBe(0);
});

test("旧会话详情迟到不能覆盖另一会话或其草稿，窄屏可继续咨询", async ({
  page,
}) => {
  await login(page);
  const a = await createChat(page, "p01"),
    b = await createChat(page, "p02"),
    first = await chatRecord(page, a),
    second = await chatRecord(page, b);
  await page.route("**/api/support/config", (route) =>
    route.fulfill({ json: { aiEnabled: true } }),
  );
  let release!: () => void, observed!: () => void;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    seen = new Promise<void>((resolve) => {
      observed = resolve;
    });
  await page.route(`**/api/support/conversations/${a}`, async (route) => {
    observed();
    await gate;
    await route.fulfill({
      json: { conversation: first, run: null, proposals: [], aiEnabled: true },
    });
  });
  await page.route(`**/api/support/conversations/${b}`, (route) =>
    route.fulfill({
      json: { conversation: second, run: null, proposals: [], aiEnabled: true },
    }),
  );
  await page.goto(`/support?conversationId=${a}`);
  await seen;
  await page.getByLabel("输入咨询内容", { exact: true }).fill("甲会话草稿");
  await page
    .locator(".conversation-list button")
    .filter({ hasText: second.title })
    .click();
  await page.getByLabel("输入咨询内容", { exact: true }).fill("乙会话草稿");
  release();
  await expect(page.locator(".chat-header h2")).toHaveText(second.title);
  await expect(page.getByLabel("输入咨询内容", { exact: true })).toHaveValue(
    "乙会话草稿",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("button", { name: "发送消息", exact: true }),
  ).toBeVisible();
  await page
    .locator(".conversation-list button")
    .filter({ hasText: first.title })
    .click();
  await expect(page.getByLabel("输入咨询内容", { exact: true })).toHaveValue(
    "甲会话草稿",
  );
});

test("文档上传进入草稿，核对后才发布，未保存编辑不能直接发布", async ({
  page,
}) => {
  await login(page, "admin");
  let uploaded = false,
    published = false,
    commands = 0;
  const doc = () => ({
    id: "doc-ui",
    name: "合成政策.txt",
    status: published ? "published" : "draft",
    version: 1,
    publishedVersion: published ? 1 : null,
    text: "满 100 元包邮，不自动退款。",
    bytes: 100,
    error: null,
    pageCount: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  await page.route("**/api/support/documents", (route) => {
    if (route.request().method() === "POST") {
      uploaded = true;
      expect(route.request().postDataJSON().requestId).toBeTruthy();
      return route.fulfill({ json: { document: doc() } });
    }
    return route.fulfill({ json: { documents: uploaded ? [doc()] : [] } });
  });
  await page.route("**/api/support/documents/doc-ui", (route) =>
    route.fulfill({ json: { document: doc() } }),
  );
  await page.route("**/api/support/documents/doc-ui/actions", (route) => {
    commands++;
    expect(route.request().postDataJSON()).toEqual({
      action: "publish",
      version: 1,
      requestId: expect.any(String),
    });
    published = true;
    return route.fulfill({ json: { document: doc() } });
  });
  await page.goto("/admin/knowledge");
  await page.getByLabel("选择知识文档").setInputFiles({
    name: "合成政策.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("满 100 元包邮，不自动退款。"),
  });
  const panel = page.getByTestId("support-documents");
  await expect(panel).toContainText("草稿待发布");
  expect(commands).toBe(0);
  await panel.getByRole("button", { name: "核对文本", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "核对知识文档",
    exact: true,
  });
  await dialog
    .getByLabel("提取文本（请重点核对金额、否定语句与复杂表格）")
    .fill("仍未保存的核对草稿");
  await expect(
    dialog.getByRole("button", { name: "核对完成，发布", exact: true }),
  ).toBeDisabled();
  await dialog
    .getByLabel("提取文本（请重点核对金额、否定语句与复杂表格）")
    .fill("满 100 元包邮，不自动退款。");
  await dialog
    .getByRole("button", { name: "核对完成，发布", exact: true })
    .click();
  await page
    .locator(".el-message-box")
    .getByRole("button", { name: "确定", exact: true })
    .click();
  await expect(panel).toContainText("已发布");
  expect(commands).toBe(1);
});

test("故障可重试，拒绝操作不会提交确认，状态变化后卡片失效", async ({
  page,
}) => {
  await login(page);
  const id = await createChat(page),
    conversation = await chatRecord(page, id);
  let retried = false,
    cancelled = false,
    expired = false,
    confirms = 0;
  await page.route("**/api/support/config", (route) =>
    route.fulfill({ json: { aiEnabled: true } }),
  );
  await page.route(`**/api/support/conversations/${id}`, (route) =>
    route.fulfill({
      json: {
        conversation,
        aiEnabled: true,
        run: {
          id: "run-failed",
          status: retried ? "completed" : "failed",
          phase: retried ? "completed" : "failed",
          error: retried ? undefined : "AI_PROVIDER_FAILED",
          degraded: retried ? ["embedding_unavailable_keyword_only"] : [],
        },
        proposals: retried
          ? [
              {
                id: "cancel-proposal",
                kind: "cancelOrder",
                summary: "取消待付款订单 TEST-1",
                details: { orderId: "TEST-1" },
                status: cancelled ? "cancelled" : "pending",
                expiresAt: new Date(Date.now() + 600000).toISOString(),
              },
              {
                id: "sale-proposal",
                kind: "requestAfterSale",
                summary: "申请售后，金额 ¥20.00",
                details: {
                  orderId: "TEST-2",
                  reason: "质量问题",
                  description: "合成用例",
                  refundAmount: 2000,
                  requiresReturn: true,
                  lines: [{ orderItemId: "line-1", quantity: 1 }],
                },
                status: expired ? "expired" : "pending",
                expiresAt: new Date(Date.now() + 600000).toISOString(),
              },
            ]
          : [],
      },
    }),
  );
  await page.route("**/api/actions/retrySupportRun", (route) => {
    expect(route.request().postDataJSON().args).toEqual(["run-failed"]);
    retried = true;
    return route.fulfill({ json: { result: null } });
  });
  await page.route("**/api/actions/cancelSupportProposal", (route) => {
    expect(route.request().postDataJSON().args).toEqual(["cancel-proposal"]);
    cancelled = true;
    return route.fulfill({ json: { result: null } });
  });
  await page.route("**/api/actions/confirmSupportProposal", (route) => {
    confirms++;
    expect(route.request().postDataJSON().args).toEqual(["sale-proposal"]);
    expired = true;
    return route.fulfill({
      status: 409,
      json: { message: "订单状态已变化，请重新确认" },
    });
  });
  await page.goto(`/support?conversationId=${id}`);
  await expect(page.locator(".support-progress").first()).toContainText(
    "AI 服务暂不可用",
  );
  await page.getByRole("button", { name: "重试本轮", exact: true }).click();
  await expect(page.locator(".support-progress").first()).toContainText(
    "已使用关键词检索",
  );
  await page
    .locator(".support-proposal")
    .first()
    .getByRole("button", { name: "不执行", exact: true })
    .click();
  await expect(page.locator(".support-proposal").first()).toContainText(
    "已取消",
  );
  expect(confirms).toBe(0);
  await expect(page.locator(".support-proposal").last()).toContainText(
    "须退回商品",
  );
  await page.getByRole("button", { name: "确认申请售后", exact: true }).click();
  await expect(page.locator(".support-proposal").last()).toContainText(
    "已失效，请重新咨询",
  );
  await expect(
    page.getByRole("button", { name: "确认申请售后", exact: true }),
  ).toHaveCount(0);
  expect(confirms).toBe(1);
});
