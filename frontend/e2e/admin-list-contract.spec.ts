import type { Page } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import {
  test,
  expect,
  TEST_ADMIN_PASSWORD,
  TEST_USER_PASSWORD,
} from "./fixtures";
const headers = { "X-ShopMate-Request": "1" };
async function action(page: Page, method: string, ...args: unknown[]) {
  const r = await page.request.post(`/api/actions/${method}`, {
    headers,
    data: { args },
  });
  expect(r.ok(), await r.text()).toBe(true);
  return (await r.json()).result;
}
async function state(page: Page) {
  return (await (await page.request.get("/api/state?role=admin")).json()).db;
}
const rows = (page: Page) => page.locator(".el-table__body-wrapper tbody tr");
test.beforeEach(async ({ page }) => {
  test.skip(!!process.env.PLAYWRIGHT_BASE_URL, "通用列表约定仅使用隔离夹具");
  for (const role of ["admin", "user"])
    expect(
      (
        await page.request.post("/api/auth/login", {
          headers,
          data: {
            role,
            username: role === "admin" ? "admin" : "lin",
            password:
              role === "admin" ? TEST_ADMIN_PASSWORD : TEST_USER_PASSWORD,
          },
        })
      ).ok(),
    ).toBe(true);
});
test("商品四页URL筛选、全量价格排序与独立编辑定位，历史导航不丢箭头", async ({
  page,
}) => {
  test.setTimeout(90000);
  const original = (await state(page)).products[0];
  for (let i = 0; i < 31; i++)
    await action(page, "saveProduct", {
      ...original,
      id: undefined,
      name: `目录分页商品${String(i).padStart(2, "0")}`,
      skus: [{ id: "", name: "标准", price: 100 + i, stock: 2 }],
    });
  const product = (await state(page)).products.find(
    (p: { name: string }) => p.name === "目录分页商品30",
  );
  await page.goto("/admin/products?q=目录分页商品&page=4&sort=asc");
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page)).toContainText("目录分页商品30");
  await page.reload();
  await expect(rows(page)).toContainText("目录分页商品30");
  const header = page.getByRole("columnheader", { name: "起售价" });
  await header.click();
  await expect(page).toHaveURL(/sort=desc/);
  await expect(rows(page).first()).toContainText("目录分页商品30");
  await page.goBack();
  await expect(header).toHaveClass(/ascending/);
  await expect(rows(page)).toHaveCount(1);
  await page.goto(`/admin/products?q=不存在的目录&detail=${product.id}`);
  const dialog = page.getByRole("dialog", { name: "编辑商品", exact: true });
  await expect(dialog.getByLabel("商品名称", { exact: true })).toHaveValue(
    product.name,
  );
  await dialog
    .getByLabel("副标题", { exact: true })
    .fill("轮询后仍保留编辑草稿");
  await page.waitForResponse((r) =>
    r.url().includes("/api/bootstrap?role=admin"),
  );
  await expect(dialog.getByLabel("副标题", { exact: true })).toHaveValue(
    "轮询后仍保留编辑草稿",
  );
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(rows(page)).toHaveCount(0);
  await page.goto("/admin/products?detail=missing-product");
  await expect(page.getByRole("dialog")).toContainText("没有找到该商品");
});
test("分类四页搜索、删除夹页、编辑独立定位及未知详情", async ({ page }) => {
  for (let i = 0; i < 31; i++)
    await action(page, "saveCategory", {
      name: `目录分页分类${String(i).padStart(2, "0")}`,
      description: "通用列表分类",
      image: "/images/p01.jpg",
      sort: 100 + i,
    });
  const category = (await state(page)).categories.find(
    (c: { name: string }) => c.name === "目录分页分类00",
  );
  await page.goto("/admin/categories?q=目录分页分类&page=4");
  await expect(rows(page)).toHaveCount(1);
  await page.reload();
  await expect(rows(page)).toHaveCount(1);
  await rows(page).getByRole("button", { name: "删除", exact: true }).click();
  await page
    .locator(".el-message-box")
    .getByRole("button", { name: "确定", exact: true })
    .click();
  await expect(page).toHaveURL(/page=3/);
  await expect(rows(page)).toHaveCount(10);
  await page.goto(`/admin/categories?q=不存在的分类&detail=${category.id}`);
  await expect(
    page.getByRole("dialog").getByLabel("分类名称", { exact: true }),
  ).toHaveValue(category.name);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "取消", exact: true })
    .click();
  await page.getByPlaceholder("搜索分类名称或描述").fill("目录分页分类00");
  await expect(rows(page)).toHaveCount(1);
  await page.goto("/admin/categories?detail=missing-category");
  await expect(page.getByRole("dialog")).toContainText("没有找到该分类");
});
test("FAQ四页查询和启停过滤、URL回退、末页收敛与草稿不被轮询覆盖", async ({
  page,
}) => {
  for (let i = 0; i < 31; i++)
    await action(page, "saveFaq", {
      question: `知识分页问答${String(i).padStart(2, "0")}`,
      keywords: [`知识分页暗号${i}`],
      answer: `知识分页答案${i}`,
      active: true,
    });
  const faq = (await state(page)).faqs.find(
    (f: { question: string }) => f.question === "知识分页问答00",
  );
  await page.goto("/admin/knowledge?q=知识分页&status=active&page=4");
  await expect(rows(page)).toHaveCount(1);
  await rows(page).locator(".el-switch__core").click();
  await expect(page).toHaveURL(/page=3/);
  await expect(rows(page)).toHaveCount(10);
  await page.goto("/admin/knowledge?q=知识分页&status=inactive");
  await expect(rows(page)).toHaveCount(1);
  await page.goBack();
  await expect(rows(page)).toHaveCount(10);
  await page.goForward();
  await expect(rows(page)).toHaveCount(1);
  await page.goto(`/admin/knowledge?q=不存在的问答&detail=${faq.id}`);
  const dialog = page.getByRole("dialog", { name: "编辑问答", exact: true });
  await expect(dialog.getByLabel("常见问题", { exact: true })).toHaveValue(
    faq.question,
  );
  await dialog
    .getByLabel("回复内容", { exact: true })
    .fill("轮询不得覆盖知识编辑草稿");
  await page.waitForResponse((r) =>
    r.url().includes("/api/bootstrap?role=admin"),
  );
  await expect(dialog.getByLabel("回复内容", { exact: true })).toHaveValue(
    "轮询不得覆盖知识编辑草稿",
  );
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await page.goto("/admin/knowledge?detail=missing-faq");
  await expect(page.getByRole("dialog")).toContainText("没有找到该问答");
});
test("客服四页与URL定位，跨页草稿不丢、翻页取消确认，筛选外及未知会话明确提示", async ({
  page,
}) => {
  test.setTimeout(90000);
  const ids: string[] = [];
  for (let i = 0; i < 31; i++) {
    const id = await action(page, "createConversation", { productId: "p01" });
    await action(page, "transferConversation", id);
    ids.push(id);
  }
  await page.goto("/admin/support?status=waiting&page=4");
  await expect(page.locator(".admin-conversation")).toHaveCount(1);
  const input = page.getByPlaceholder("输入人工回复。发送后会话转为人工接待。");
  await input.fill("第四页会话的草稿");
  await page.getByRole("listitem", { name: "第 1 页", exact: true }).click();
  await expect(page.locator(".admin-conversation")).toHaveCount(10);
  await input.fill("第一页会话的草稿");
  await page.getByRole("listitem", { name: "第 4 页", exact: true }).click();
  await expect(input).toHaveValue("第四页会话的草稿");
  await page.getByRole("button", { name: "关闭会话", exact: true }).click();
  await expect(page.locator(".el-message-box")).toContainText(ids[0]!);
  await page.goBack();
  await expect(page.locator(".el-message-box")).not.toBeVisible();
  await expect(input).toHaveValue("第一页会话的草稿");
  await page.goto(`/admin/support?status=closed&detail=${ids[0]}`);
  await expect(page.locator(".admin-chat-body")).toContainText(
    "目标会话不符合当前筛选",
  );
  await expect(page.locator(".admin-chat-body h2")).toHaveCount(0);
  await page
    .getByRole("button", { name: "清除筛选并定位", exact: true })
    .click();
  await expect(page).toHaveURL(/page=4/);
  await expect(page).not.toHaveURL(/status=closed/);
  await expect(page.locator(".admin-chat-body")).toContainText(ids[0]!);
  await page.reload();
  await expect(page.locator(".admin-chat-body")).toContainText(ids[0]!);
  await page.goto(`/admin/support?status=waiting&page=1&detail=${ids[0]}`);
  await expect(
    page.getByRole("button", { name: "定位到该会话页", exact: true }),
  ).toHaveCount(1);
  await page
    .getByRole("button", { name: "定位到该会话页", exact: true })
    .click();
  await expect(page).toHaveURL(/page=4/);
  await page.goto("/admin/support?detail=missing-chat");
  await expect(page.locator(".admin-chat-body")).toContainText(
    "没有找到该会话",
  );
  await expect(page.locator(".admin-chat-body h2")).toHaveCount(0);
});
test("异步图片校验期间切换管理员会关闭旧草稿，旧任务不得在新身份下提交", async ({
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
  const product = (await state(page)).products[0];
  await page.goto(`/admin/products?detail=${product.id}`);
  const dialog = page.getByRole("dialog", { name: "编辑商品", exact: true });
  await dialog
    .getByLabel("副标题", { exact: true })
    .fill("前管理员的未保存草稿");
  await page.evaluate(() => {
    const scope = window as typeof window & {
      originalDecode?: HTMLImageElement["decode"];
      releaseDecode?: () => void;
      decoding?: boolean;
    };
    scope.originalDecode = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = () => {
      scope.decoding = true;
      return new Promise<void>((resolve) => {
        scope.releaseDecode = resolve;
      });
    };
  });
  let posts = 0;
  page.on("request", (request) => {
    if (request.url().includes("/api/actions/saveProduct")) posts++;
  });
  await dialog.getByRole("button", { name: "保存商品", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => !!(window as typeof window & { decoding?: boolean }).decoding,
      ),
    )
    .toBe(true);
  const tab = await context.newPage();
  expect(
    (
      await tab.request.post("/api/auth/login", {
        headers,
        data: {
          role: "admin",
          username: "admin2",
          password: TEST_ADMIN_PASSWORD,
        },
      })
    ).ok(),
  ).toBe(true);
  await expect(dialog).not.toBeVisible();
  await page.evaluate(() => {
    const scope = window as typeof window & {
      originalDecode?: HTMLImageElement["decode"];
      releaseDecode?: () => void;
    };
    if (scope.originalDecode)
      HTMLImageElement.prototype.decode = scope.originalDecode;
    scope.releaseDecode?.();
  });
  await expect(
    page.getByText("编辑目标或登录身份已变化，请重新核对后提交", {
      exact: true,
    }),
  ).toBeVisible();
  expect(posts).toBe(0);
  expect(
    (await state(page)).products.find(
      (p: { id: string }) => p.id === product.id,
    ).subtitle,
  ).toBe(product.subtitle);
  await tab.close();
});
test("URL切换编辑记录时，旧保存响应不关闭或覆盖新目标", async ({ page }) => {
  const db = await state(page),
    a = db.products[0],
    b = db.products[1];
  await page.goto(`/admin/products?detail=${a.id}`);
  await page.goto(`/admin/products?detail=${b.id}`);
  const dialog = page.getByRole("dialog", { name: "编辑商品", exact: true });
  await dialog
    .getByLabel("副标题", { exact: true })
    .fill("旧目标已确认保存内容");
  let release!: () => void, captured!: () => void;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    seen = new Promise<void>((resolve) => {
      captured = resolve;
    });
  await page.route("**/api/actions/saveProduct", async (route) => {
    const response = await route.fetch();
    captured();
    await gate;
    await route.fulfill({ response });
  });
  await dialog.getByRole("button", { name: "保存商品", exact: true }).click();
  await seen;
  await page.goBack();
  release();
  await expect(dialog.getByLabel("商品名称", { exact: true })).toHaveValue(
    a.name,
  );
  await expect(
    dialog.getByRole("button", { name: "保存商品", exact: true }),
  ).toBeEnabled();
  const after = await state(page);
  expect(
    after.products.find((p: { id: string }) => p.id === a.id).subtitle,
  ).toBe(a.subtitle);
  expect(
    after.products.find((p: { id: string }) => p.id === b.id).subtitle,
  ).toBe("旧目标已确认保存内容");
});
