import type { Page } from "@playwright/test";
import {
  test,
  expect,
  TEST_USER_PASSWORD,
  TEST_ADMIN_PASSWORD,
} from "./fixtures";
import { readFile } from "node:fs/promises";
test.use({ timezoneId: "Asia/Shanghai" });

async function login(page: Page, role: "admin" | "user" = "admin") {
  await page.goto(role === "admin" ? "/admin/login" : "/login");
  await page
    .getByLabel("账号", { exact: true })
    .fill(role === "admin" ? "admin" : "lin");
  await page
    .getByLabel("密码", { exact: true })
    .fill(role === "admin" ? TEST_ADMIN_PASSWORD : TEST_USER_PASSWORD);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(role === "admin" ? /\/admin$/ : /\/$/);
}

test("商品上下架即时同步到已打开的商城标签页，并在刷新后保持", async ({
  page,
  context,
}) => {
  await login(page);
  const storefront = await context.newPage();
  await storefront.goto("/products/p01");
  await expect(
    storefront.getByRole("button", { name: "加入购物车" }),
  ).toBeEnabled();
  await page.goto("/admin/products");
  await page.getByPlaceholder("搜索商品名称").fill("静听 无线头戴耳机");
  await expect(page.locator(".el-table__body-wrapper tbody tr")).toHaveCount(1);
  await page.getByRole("button", { name: "下架", exact: true }).click();
  await page.getByRole("button", { name: "确定", exact: true }).click();
  await expect(page.getByText("商品状态已更新", { exact: true })).toBeVisible();
  await expect(
    storefront.getByText("此商品已下架，暂时无法购买。"),
  ).toBeVisible();
  await expect(
    storefront.getByRole("button", { name: "加入购物车" }),
  ).toBeDisabled();
  await storefront.reload();
  await expect(
    storefront.getByText("此商品已下架，暂时无法购买。"),
  ).toBeVisible();
  await page.getByRole("button", { name: "上架", exact: true }).click();
  await page.getByRole("button", { name: "确定", exact: true }).click();
  await expect(
    storefront.getByRole("button", { name: "加入购物车" }),
  ).toBeEnabled();
});

test("补货增加指定 SKU 库存并写入采购流水，导出的是筛选后的 CSV", async ({
  page,
}) => {
  // Events are now timestamped by the server, not the browser clock.
  const eventDate = new Date().toLocaleDateString("sv-SE", {
    timeZone: "Asia/Shanghai",
  });
  await login(page);
  await page.goto("/admin/inventory");
  await page
    .getByPlaceholder("搜索商品、规格或变动编号 / 原因")
    .fill("p03-s1");
  await expect(page.locator(".el-table__body-wrapper tbody tr")).toHaveCount(1);
  const row = page.locator(".el-table__body-wrapper tbody tr").first();
  const before = Number(
    (await row.locator("td").nth(2).innerText()).replace(/\D/g, ""),
  );
  await row.getByRole("button", { name: "补货 / 调整" }).click();
  const dialog = page.getByRole("dialog", { name: "调整库存" });
  await dialog.getByRole("spinbutton").nth(0).fill("7");
  await dialog
    .getByLabel("本次采购总支出（元，0 表示无采购成本）", { exact: true })
    .fill("123.45");
  await dialog
    .getByPlaceholder("例如：到货入库 / 盘点修正")
    .fill("验收补货采购");
  await dialog.getByRole("button", { name: "确认调整" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(row.locator("td").nth(2)).toContainText(`${before + 7} 件`);
  await page.getByRole("tab", { name: "变动记录" }).click();
  await expect(page.getByText("验收补货采购", { exact: true })).toBeVisible();
  await page.goto("/admin/finance");
  await expect(page.getByText("验收补货采购", { exact: true })).toBeVisible();
  await page.getByPlaceholder("开始日期").fill(eventDate);
  await page.getByPlaceholder("结束日期").fill(eventDate);
  await page.getByPlaceholder("结束日期").press("Enter");
  await expect(page.getByText("验收补货采购", { exact: true })).toBeVisible();
  await page.locator(".admin-toolbar .el-select").click();
  await page.getByRole("option", { name: "采购支出", exact: true }).click();
  await expect(page.locator(".el-table__body-wrapper tbody tr")).toHaveCount(1);
  await expect(page.locator(".el-table__body-wrapper")).toContainText(
    "¥123.45",
  );
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出当前 CSV" }).click();
  const download = await downloadEvent;
  const path = await download.path();
  expect(path).toBeTruthy();
  const csv = await readFile(path!, "utf8");
  expect(csv).toContain("验收补货采购");
  expect(csv).toContain("123.45");
  expect(csv).not.toContain("初始演示订单收款");
});

test("新增 FAQ 参与用户规则回复，转人工后管理回复同步到用户", async ({
  page,
  context,
}) => {
  await login(page);
  await page.goto("/admin/knowledge");
  await page.getByRole("button", { name: "新增问答" }).click();
  const dialog = page.getByRole("dialog", { name: "新增问答" });
  await dialog.locator("input").nth(0).fill("验收专属咨询");
  await dialog.getByPlaceholder("配送，运费，包邮").fill("验收暗号");
  await dialog.locator("textarea").fill("这是验收规则的唯一回复。");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const user = await context.newPage();
  await login(user, "user");
  await user.goto("/support");
  await user.getByLabel("输入咨询内容").fill("验收暗号");
  await user.getByRole("button", { name: "发送消息" }).click();
  await expect(
    user.getByText("这是验收规则的唯一回复。", { exact: true }),
  ).toBeVisible();
  await user.getByRole("button", { name: "转人工", exact: true }).click();
  await expect(user.locator(".chat-header")).toContainText("等待人工接入");
  await page.goto("/admin/support");
  await expect(page.locator(".admin-chat-body")).toContainText("验收暗号");
  await page
    .getByPlaceholder("输入人工回复。发送后会话转为人工接待。")
    .fill("人工已接入，本次问题已核对。");
  await page.getByRole("button", { name: "发送回复" }).click();
  await expect(
    user.getByText("人工已接入，本次问题已核对。", { exact: true }),
  ).toBeVisible();
  await expect(user.locator(".chat-header")).toContainText("人工服务中");
  await page.getByRole("button", { name: "关闭会话", exact: true }).click();
  await page.getByRole("button", { name: "确定", exact: true }).click();
  await expect(user.getByText("会话已结束，历史记录仍可查看。")).toBeVisible();
});

test("引用中的分类禁止删除，默认关闭网页演示重置", async ({ page }) => {
  await login(page);
  await page.goto("/admin/categories");
  const row = page
    .locator(".el-table__body-wrapper tbody tr")
    .filter({ hasText: "数码电器" });
  await row.getByRole("button", { name: "删除", exact: true }).click();
  await page.getByRole("button", { name: "确定", exact: true }).click();
  await expect(
    page.getByText("该分类仍有关联商品，请先调整商品分类"),
  ).toBeVisible();
  await expect(row).toBeVisible();
  await page.goto("/admin/settings");
  await expect(page.getByRole("button", { name: "恢复演示数据" })).toHaveCount(
    0,
  );
  expect(
    (
      await page.request.post("/api/actions/resetDemo", {
        headers: { "X-ShopMate-Request": "1" },
        data: { args: [] },
      })
    ).status(),
  ).toBe(403);
});
