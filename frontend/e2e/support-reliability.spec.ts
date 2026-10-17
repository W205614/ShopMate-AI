import type { Page } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import {
  test,
  expect,
  TEST_ADMIN_PASSWORD,
  TEST_USER_PASSWORD,
} from "./fixtures";
const headers = { "X-ShopMate-Request": "1" },
  placeholder = "输入人工回复。发送后会话转为人工接待。";
async function action(page: Page, method: string, ...args: unknown[]) {
  const response = await page.request.post(`/api/actions/${method}`, {
    headers,
    data: { args },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).result;
}
async function state(page: Page) {
  return (await (await page.request.get("/api/state?role=admin")).json()).db;
}
async function login(page: Page, username = "admin") {
  expect(
    (
      await page.request.post("/api/auth/login", {
        headers,
        data: { role: "admin", username, password: TEST_ADMIN_PASSWORD },
      })
    ).ok(),
  ).toBe(true);
}
async function chats(page: Page) {
  const a = await action(page, "createConversation", { productId: "p01" }),
    b = await action(page, "createConversation", { productId: "p02" });
  await action(page, "transferConversation", a);
  await action(page, "transferConversation", b);
  const db = await state(page);
  return {
    a,
    b,
    nameA: db.products.find((p: { id: string }) => p.id === "p01").name,
    nameB: db.products.find((p: { id: string }) => p.id === "p02").name,
  };
}
test.beforeEach(async ({ page }) => {
  test.skip(!!process.env.PLAYWRIGHT_BASE_URL, "客服可靠性仅使用隔离夹具");
  await login(page);
  expect(
    (
      await page.request.post("/api/auth/login", {
        headers,
        data: { role: "user", username: "lin", password: TEST_USER_PASSWORD },
      })
    ).ok(),
  ).toBe(true);
});
test("切换会话保留各自草稿和轮询，筛选空结果不显示旧会话", async ({ page }) => {
  const { nameA, nameB } = await chats(page);
  await page.goto("/admin/support?status=waiting");
  const choose = (name: string) =>
    page.locator(".admin-conversation").filter({ hasText: name }).click();
  await choose(nameA);
  await page.getByPlaceholder(placeholder).fill("会话甲的未发送草稿");
  await choose(nameB);
  await page.getByPlaceholder(placeholder).fill("会话乙的未发送草稿");
  await choose(nameA);
  await expect(page.getByPlaceholder(placeholder)).toHaveValue(
    "会话甲的未发送草稿",
  );
  await page.waitForResponse(
    (r) =>
      r.url().includes("/api/state?role=admin") &&
      r.request().method() === "GET",
  );
  await expect(page.getByPlaceholder(placeholder)).toHaveValue(
    "会话甲的未发送草稿",
  );
  await page.locator(".admin-chat-list .el-select").click();
  await page.getByRole("option", { name: "已关闭", exact: true }).click();
  await expect(page.locator(".admin-conversation")).toHaveCount(0);
  await expect(page.locator(".admin-chat-body h2")).toHaveCount(0);
  await expect(page.locator(".admin-chat-body")).toContainText(
    "选择会话开始处理",
  );
  await page.goBack();
  await expect(page.locator(".admin-conversation")).toHaveCount(2);
  await choose(nameB);
  await expect(page.getByPlaceholder(placeholder)).toHaveValue(
    "会话乙的未发送草稿",
  );
});
test("甲回复响应迟到不清除乙草稿，也不清除甲新输入，消息只发送一次", async ({
  page,
}) => {
  const { a, b, nameA, nameB } = await chats(page);
  await page.goto("/admin/support");
  await page.locator(".admin-conversation").filter({ hasText: nameA }).click();
  await page.getByPlaceholder(placeholder).fill("甲这次发送的消息");
  let release!: () => void,
    captured!: () => void,
    posts = 0;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    seen = new Promise<void>((resolve) => {
      captured = resolve;
    });
  await page.route("**/api/actions/replyConversation", async (route) => {
    posts++;
    const response = await route.fetch();
    captured();
    await gate;
    await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "发送回复", exact: true }).click();
  await seen;
  await page.locator(".admin-conversation").filter({ hasText: nameB }).click();
  await page.getByPlaceholder(placeholder).fill("乙不能被迟到响应清掉的草稿");
  release();
  await expect(
    page.getByRole("button", { name: "发送回复", exact: true }),
  ).toBeEnabled();
  await expect(page.getByPlaceholder(placeholder)).toHaveValue(
    "乙不能被迟到响应清掉的草稿",
  );
  await page.locator(".admin-conversation").filter({ hasText: nameA }).click();
  await expect(page.getByPlaceholder(placeholder)).toHaveValue("");
  expect(
    (await state(page)).conversations
      .find((c: { id: string }) => c.id === a)
      .messages.filter((m: { role: string }) => m.role === "agent"),
  ).toHaveLength(1);
  expect(
    (await state(page)).conversations
      .find((c: { id: string }) => c.id === b)
      .messages.filter((m: { role: string }) => m.role === "agent"),
  ).toHaveLength(0);
  // A second delayed response must not erase a newer draft in the same chat.
  let nextRelease!: () => void, nextCaptured!: () => void;
  const nextGate = new Promise<void>((resolve) => {
      nextRelease = resolve;
    }),
    nextSeen = new Promise<void>((resolve) => {
      nextCaptured = resolve;
    });
  await page.unroute("**/api/actions/replyConversation");
  await page.route("**/api/actions/replyConversation", async (route) => {
    posts++;
    const response = await route.fetch();
    nextCaptured();
    await nextGate;
    await route.fulfill({ response });
  });
  await page.getByPlaceholder(placeholder).fill("甲第二次发送");
  await page.getByRole("button", { name: "发送回复", exact: true }).click();
  await nextSeen;
  await page.getByPlaceholder(placeholder).fill("甲新输入留给下一次");
  nextRelease();
  await expect(
    page.getByRole("button", { name: "发送回复", exact: true }),
  ).toBeEnabled();
  await expect(page.getByPlaceholder(placeholder)).toHaveValue(
    "甲新输入留给下一次",
  );
  expect(posts).toBe(2);
});
test("未知回复保留草稿且不自动重发，同管理员断网恢复保留草稿，远端关闭仍可复制", async ({
  page,
}) => {
  const { a, nameA } = await chats(page);
  await page.goto("/admin/support");
  await page.locator(".admin-conversation").filter({ hasText: nameA }).click();
  let posts = 0;
  await page.route("**/api/actions/replyConversation", async (route) => {
    posts++;
    await route.fetch();
    await route.abort("failed");
  });
  await page.getByPlaceholder(placeholder).fill("结果未知应先核对这条回复");
  await page.getByRole("button", { name: "发送回复", exact: true }).click();
  await expect(page.getByText(/结果暂无法确认/).first()).toBeVisible();
  await expect(page.getByPlaceholder(placeholder)).toHaveValue(
    "结果未知应先核对这条回复",
  );
  await page.waitForResponse(
    (r) =>
      r.url().includes("/api/state?role=admin") &&
      r.request().method() === "GET",
  );
  expect(posts).toBe(1);
  await page.route("**/api/state?role=admin", (route) => route.abort("failed"));
  await expect(
    page.getByRole("button", { name: "重新连接", exact: true }),
  ).toBeVisible();
  await expect(page.getByPlaceholder(placeholder)).toHaveValue(
    "结果未知应先核对这条回复",
  );
  await page.unroute("**/api/state?role=admin");
  await page.getByRole("button", { name: "重新连接", exact: true }).click();
  await expect(page.getByPlaceholder(placeholder)).toHaveValue(
    "结果未知应先核对这条回复",
  );
  await action(page, "closeConversation", a);
  await expect(page.getByPlaceholder(placeholder)).toHaveAttribute(
    "readonly",
    "",
  );
  await expect(page.getByPlaceholder(placeholder)).toHaveValue(
    "结果未知应先核对这条回复",
  );
  await expect(
    page.getByRole("button", { name: "发送回复", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("会话已关闭，未发送草稿仅供复制。", { exact: true }),
  ).toBeVisible();
  expect(posts).toBe(1);
});
test("筛选导航取消旧关闭确认，不对另一会话提交关闭", async ({ page }) => {
  const { a, b, nameA } = await chats(page);
  await page.goto("/admin/support?status=waiting");
  await page.goto("/admin/support");
  await page.locator(".admin-conversation").filter({ hasText: nameA }).click();
  let posts = 0;
  page.on("request", (r) => {
    if (r.url().includes("/api/actions/closeConversation")) posts++;
  });
  await page.getByRole("button", { name: "关闭会话", exact: true }).click();
  await expect(page.locator(".el-message-box")).toContainText(a);
  await page.goBack();
  await expect(page.locator(".el-message-box")).not.toBeVisible();
  expect(posts).toBe(0);
  for (const id of [a, b])
    expect(
      (await state(page)).conversations.find((c: { id: string }) => c.id === id)
        .status,
    ).toBe("waiting");
});
test("跨标签管理员切换清空私有草稿并取消旧身份关闭确认", async ({
  page,
  context,
}) => {
  const sql = new DatabaseSync(resolve("../backend/.e2e/shopmate.sqlite"));
  try {
    sql
      .prepare(
        "INSERT INTO accounts SELECT 'admin2','admin2','备用管理员',role,password_hash,created_at FROM accounts WHERE id='admin'",
      )
      .run();
  } finally {
    sql.close();
  }
  const { nameA } = await chats(page);
  await page.goto("/admin/support");
  await page.locator(".admin-conversation").filter({ hasText: nameA }).click();
  await page.getByPlaceholder(placeholder).fill("原管理员私有草稿不能跨账号");
  await page.getByRole("button", { name: "关闭会话", exact: true }).click();
  const tab = await context.newPage();
  await login(tab, "admin2");
  await expect(page.locator(".el-message-box")).not.toBeVisible();
  await expect(page.getByPlaceholder(placeholder)).toHaveValue("");
  await page.getByPlaceholder(placeholder).fill("新管理员草稿");
  await login(tab);
  await expect(page.getByPlaceholder(placeholder)).toHaveValue("");
  await tab.close();
});
test("FAQ编辑即时作用于后续规则回复，停用后不再命中旧答案", async ({
  page,
  context,
}) => {
  await action(page, "saveFaq", {
    question: "客服联动专属问答",
    keywords: ["联动验证暗号"],
    answer: "首次规则回复内容",
    active: true,
  });
  await action(page, "createConversation", {});
  const customer = await context.newPage();
  await customer.goto("/support");
  const send = async () => {
    await customer
      .getByLabel("输入咨询内容", { exact: true })
      .fill("联动验证暗号");
    await customer
      .getByRole("button", { name: "发送消息", exact: true })
      .click();
  };
  await send();
  await expect(customer.locator(".message-assistant").last()).toContainText(
    "首次规则回复内容",
  );
  await page.goto("/admin/knowledge");
  const row = page
    .locator(".el-table__body-wrapper tbody tr")
    .filter({ hasText: "客服联动专属问答" });
  await row.getByRole("button", { name: "编辑", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "编辑问答", exact: true });
  await dialog.locator("textarea").fill("更新后的规则回复内容");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await send();
  await expect(customer.locator(".message-assistant").last()).toContainText(
    "更新后的规则回复内容",
  );
  await row.locator(".el-switch__core").click();
  await expect(row.getByRole("switch")).not.toBeChecked();
  await send();
  await expect(customer.locator(".message-user")).toHaveCount(3);
  await expect(customer.locator(".message-assistant")).toHaveCount(4);
  await expect(customer.locator(".message-assistant").last()).not.toContainText(
    "更新后的规则回复内容",
  );
  await expect(customer.locator(".message-assistant").last()).not.toContainText(
    "首次规则回复内容",
  );
  await customer.close();
});
test("旧回复跨管理员及页面返回后不能清除新实例草稿", async ({
  page,
  context,
}) => {
  test.setTimeout(60000);
  const sql = new DatabaseSync(resolve("../backend/.e2e/shopmate.sqlite"));
  try {
    sql
      .prepare(
        "INSERT INTO accounts SELECT 'admin2','admin2','备用管理员',role,password_hash,created_at FROM accounts WHERE id='admin'",
      )
      .run();
  } finally {
    sql.close();
  }
  const { a, nameA } = await chats(page);
  await page.goto("/admin/support");
  await page.locator(".admin-conversation").filter({ hasText: nameA }).click();
  const tab = await context.newPage();
  let posts = 0;
  for (const changeOwner of [true, false]) {
    let release!: () => void, captured!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
      }),
      seen = new Promise<void>((resolve) => {
        captured = resolve;
      });
    await page.route("**/api/actions/replyConversation", async (route) => {
      posts++;
      const response = await route.fetch();
      captured();
      await gate;
      await route.fulfill({ response });
    });
    await page
      .getByPlaceholder(placeholder)
      .fill(changeOwner ? "原管理员已发送" : "离开前已发送");
    await page.getByRole("button", { name: "发送回复", exact: true }).click();
    await seen;
    if (changeOwner) {
      await login(tab, "admin2");
      await page.waitForResponse(
        (r) =>
          r.url().includes("/api/state?role=admin") &&
          r.request().method() === "GET",
      );
      await expect(page.getByPlaceholder(placeholder)).toHaveValue("");
    } else {
      await page.goto("/admin/orders");
      await page.goto("/admin/support");
    }
    await page
      .locator(".admin-conversation")
      .filter({ hasText: nameA })
      .click();
    await page.getByPlaceholder(placeholder).fill("新界面的草稿需要保留");
    release();
    for (let i = 0; i < 2; i++)
      await page.waitForResponse(
        (r) =>
          r.url().includes("/api/state?role=admin") &&
          r.request().method() === "GET",
      );
    await expect(page.getByPlaceholder(placeholder)).toHaveValue(
      "新界面的草稿需要保留",
    );
    await expect(
      page.getByRole("button", { name: "发送回复", exact: true }),
    ).toBeEnabled();
    await page.unroute("**/api/actions/replyConversation");
  }
  expect(posts).toBe(2);
  expect(
    (await state(page)).conversations
      .find((c: { id: string }) => c.id === a)
      .messages.filter((m: { role: string }) => m.role === "agent"),
  ).toHaveLength(2);
  await tab.close();
});
