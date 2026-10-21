import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { APIRequestContext, Page } from "@playwright/test";
import type { Product } from "../../shared/domain/types";
import type { PurchaseOrder, StaffRole } from "../../shared/domain/operations";
import { test, expect, TEST_ADMIN_PASSWORD } from "./fixtures";

const headers = { "X-ShopMate-Request": "1" }, password = "FinalRole123!";
async function action<T = void>(request: APIRequestContext, method: string, ...args: unknown[]): Promise<T> {
  const response = await request.post(`/api/actions/${method}`, { headers, data: { args, requestId: randomUUID() } });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).result as T;
}
async function owner(request: APIRequestContext) {
  const response = await request.post("/api/auth/login", { headers, data: { role: "admin", username: "admin", password: TEST_ADMIN_PASSWORD } });
  expect(response.ok(), await response.text()).toBe(true);
}
async function createStaff(request: APIRequestContext, role: StaffRole, suffix: string) {
  const username = `final_${role}_${suffix}`;
  await action(request, "saveStaff", { username, name: `最终验收${role}`, password, staffRole: role, active: true });
  return username;
}
async function login(page: Page, username: string) {
  await page.goto("/admin/login");
  await page.getByLabel("账号", { exact: true }).fill(username);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
}
test.beforeEach(({ baseURL }) => {
  if (process.env.PLAYWRIGHT_BASE_URL) {
    expect(process.env.E2E_MUTATIONS_ALLOWED, "真实角色写入验收需要明确允许隔离写入").toBe("1");
    expect(new URL(baseURL!).port, "不得对日常18086执行写入验收").not.toBe("18086");
    expect(["localhost", "127.0.0.1"]).toContain(new URL(baseURL!).hostname);
  }
});

test("客服实际员工接手转人工会话，顾客窄屏无需刷新收到回复", async ({ page, browser, baseURL }) => {
  test.setTimeout(90000);
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  await owner(page.request);
  const username = await createStaff(page.request, "support", suffix);
  const customerContext = await browser.newContext({ baseURL, viewport: { width: 390, height: 900 } });
  const customer = await customerContext.newPage();
  const errors: string[] = [];
  for (const entry of [page, customer]) entry.on("pageerror", error => errors.push(error.message));
  try {
    const registered = await customer.request.post("/api/auth/register", { headers, data: { username: `final_user_${suffix}`, name: "最终客服验收顾客", password } });
    expect(registered.status(), await registered.text()).toBe(201);
    const id = await action<string>(customer.request, "createConversation");
    // Transfer before sending: this real UI scenario does not consume a model call.
    await customer.goto(`/support?conversationId=${id}`);
    await customer.getByRole("button", { name: "转人工", exact: true }).click();
    await expect(customer.locator(".chat-header")).toContainText("等待人工接入");
    const question = `人工协助核对售后流程 ${suffix}`;
    await customer.getByLabel("输入咨询内容", { exact: true }).fill(question);
    await customer.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(customer.locator(".chat-messages")).toContainText(question);
    await login(page, username);
    await page.goto(`/admin/support?detail=${id}`);
    await expect(page.locator(".admin-messages")).toContainText(question);
    const reply = `您好，已转人工，可在本人订单查看售后状态 ${suffix}`;
    await page.getByPlaceholder("输入人工回复。发送后会话转为人工接待。").fill(reply);
    await page.getByRole("button", { name: "发送回复", exact: true }).click();
    await expect(page.locator(".admin-messages")).toContainText(reply);
    await expect(customer.locator(".chat-messages")).toContainText(reply, { timeout: 15000 });
    await expect(customer.locator(".chat-header")).toContainText("人工服务中");
    const detail = await (await customer.request.get(`/api/support/conversations/${id}`)).json();
    expect(detail.conversation.messages.filter((message: { text: string }) => message.text === reply)).toHaveLength(1);
    expect(detail.run).toBeFalsy();
    expect(await customer.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect((await page.request.get("/api/admin/diagnostics")).status()).toBe(403);
    expect(errors).toEqual([]);
  } finally { await customerContext.close(); }
});

test("仓储实际员工分批采购入库，财务实际员工筛选并导出对应流水", async ({ page, browser, baseURL }) => {
  test.setTimeout(120000);
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  await owner(page.request);
  const warehouse = await createStaff(page.request, "warehouse", suffix);
  const finance = await createStaff(page.request, "finance", suffix);
  const financeContext = await browser.newContext({ baseURL });
  const financePage = await financeContext.newPage();
  const errors: string[] = [];
  for (const entry of [page, financePage]) entry.on("pageerror", error => errors.push(error.message));
  try {
    await login(page, warehouse);
    await page.goto("/admin/operations?tab=suppliers");
    await page.getByRole("button", { name: "新增供应商", exact: true }).click();
    let dialog = page.getByRole("dialog");
    const supplierName = `仓储合成供应商${suffix}`;
    await dialog.getByRole("textbox").nth(0).fill(supplierName);
    await dialog.getByRole("textbox").nth(1).fill("13800000000");
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    const products = await (await page.request.get("/api/collections/products?role=admin&pageSize=1")).json();
    const product = products.items[0] as Product, sku = product.skus[0]!, beforeStock = sku.stock;
    await page.getByRole("button", { name: "采购入库", exact: true }).click();
    await page.getByRole("button", { name: "新增采购单", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "采购草稿", exact: true });
    await dialog.getByRole("combobox").nth(0).fill(supplierName);
    await page.getByRole("option", { name: supplierName, exact: true }).click();
    await dialog.getByRole("combobox").nth(1).fill(product.name);
    await page.getByRole("option", { name: product.name, exact: true }).click();
    await dialog.locator(".el-select").nth(2).click();
    await page.getByRole("option", { name: sku.name, exact: true }).click();
    await dialog.getByRole("spinbutton").nth(0).fill("3");
    await dialog.getByRole("spinbutton").nth(1).fill("123");
    const created = page.waitForResponse(response => response.url().endsWith("/api/actions/createPurchaseOrder"));
    await dialog.getByRole("button", { name: "创建草稿", exact: true }).click();
    const result = await created;
    expect(result.ok(), await result.text()).toBe(true);
    const purchaseId = ((await result.json()).result as PurchaseOrder).id;
    await expect(dialog).not.toBeVisible();
    const row = page.locator(".el-table__body-wrapper tbody tr").filter({ hasText: purchaseId });
    await row.getByRole("button", { name: "下单", exact: true }).click();
    await expect(row).toContainText("已下单");
    for (const quantity of [1, 2]) {
      await row.getByRole("button", { name: "分批入库", exact: true }).click();
      const receiving = page.getByRole("dialog", { name: "分批入库", exact: true });
      await receiving.getByRole("spinbutton").fill(String(quantity));
      await receiving.getByRole("button", { name: "确认本次入库", exact: true }).click();
      await expect(receiving).not.toBeVisible();
    }
    await expect(row).toContainText("已入库");
    const after = await (await page.request.get(`/api/collections/products?role=admin&id=${product.id}`)).json();
    expect((after.items[0] as Product).skus.find(entry => entry.id === sku.id)!.stock).toBe(beforeStock + 3);
    expect((await page.request.get("/api/collections/ledger?role=admin")).status()).toBe(403);
    await login(financePage, finance);
    await financePage.goto("/admin/finance");
    await financePage.getByPlaceholder("流水号 / 关联编号 / 说明").fill(purchaseId);
    await expect(financePage.locator(".el-table__body-wrapper tbody tr")).toHaveCount(2);
    const download = financePage.waitForEvent("download");
    await financePage.getByRole("button", { name: "导出当前 CSV", exact: true }).click();
    const csv = await readFile((await (await download).path())!, "utf8");
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.split("\n").filter(line => line.includes(purchaseId))).toHaveLength(2);
    expect(csv).toContain("1.23"); expect(csv).toContain("2.46");
    expect((await financePage.request.get("/api/collections/inventory?role=admin")).status()).toBe(403);
    expect(errors).toEqual([]);
  } finally { await financeContext.close(); }
});
