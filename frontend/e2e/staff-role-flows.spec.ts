import { randomUUID } from "node:crypto";
import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect, TEST_ADMIN_PASSWORD } from "./fixtures";
import type {
  AfterSale,
  CheckoutQuote,
  Order,
} from "../../shared/domain/types";
import type { StaffRole } from "../../shared/domain/operations";

const headers = { "X-ShopMate-Request": "1" };
const staffPassword = "RoleStaff123!";
async function action<T = void>(
  request: APIRequestContext,
  method: string,
  ...args: unknown[]
): Promise<T> {
  const response = await request.post(`/api/actions/${method}`, {
    headers,
    data: { args, requestId: randomUUID() },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).result as T;
}
async function records<T>(
  request: APIRequestContext,
  collection: string,
  query = "",
): Promise<T[]> {
  const response = await request.get(`/api/collections/${collection}?${query}`);
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).items as T[];
}
async function owner(request: APIRequestContext) {
  const response = await request.post("/api/auth/login", {
    headers,
    data: { role: "admin", username: "admin", password: TEST_ADMIN_PASSWORD },
  });
  expect(response.ok(), await response.text()).toBe(true);
}
async function staffLogin(page: Page, username: string) {
  await page.goto("/admin/login");
  await page.getByLabel("账号", { exact: true }).fill(username);
  await page.getByLabel("密码", { exact: true }).fill(staffPassword);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/);
}
async function paidOrder(request: APIRequestContext) {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const response = await request.post("/api/auth/register", {
    headers,
    data: {
      username: `role_buyer_${suffix}`,
      name: "角色验收买家",
      password: staffPassword,
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  await action(request, "saveAddress", {
    name: "角色验收收件人",
    phone: "13800000000",
    province: "上海市",
    region: "上海市 徐汇区",
    detail: "隔离角色验收路1号",
    isDefault: true,
  });
  const address = (
    await records<{ id: string }>(request, "addresses", "role=user")
  )[0]!;
  const quote = await action<CheckoutQuote>(request, "quoteCheckout", {
    source: { type: "buyNow", productId: "p01", skuId: "p01-s1", quantity: 1 },
    addressId: address.id,
  });
  const id = await action<string>(request, "createOrder", {
    quoteId: quote.id,
    requestId: randomUUID(),
  });
  await action(request, "payOrder", id);
  return { id, suffix };
}
async function processSale(page: Page, label: string) {
  const response = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/actions/processAfterSale") &&
      r.request().method() === "POST",
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: label, exact: true })
    .click();
  await page.getByRole("button", { name: "确定", exact: true }).click();
  const result = await response;
  expect(result.ok(), await result.text()).toBe(true);
}
const buttons = ["批准申请", "拒绝", "确认收到退货", "执行模拟退款"];
async function expectActions(page: Page, allowed: string[]) {
  for (const label of buttons) {
    const button = page
      .getByRole("dialog")
      .getByRole("button", { name: label, exact: true });
    if (allowed.includes(label)) await expect(button).toBeVisible();
    else await expect(button).toHaveCount(0);
  }
}

test.beforeEach(() => {
  test.skip(
    !!process.env.PLAYWRIGHT_BASE_URL &&
      process.env.E2E_MUTATIONS_ALLOWED !== "1",
    "角色写入验收只允许隔离部署",
  );
});

for (const role of ["support", "warehouse", "finance"] as const) {
  test(`${role} 实际账号仅展示可执行售后动作并完成本职交接`, async ({
    page,
    browser,
    baseURL,
  }) => {
    test.setTimeout(120000);
    await owner(page.request);
    const { id, suffix } = await paidOrder(page.request);
    const username = `role_${role}_${suffix}`;
    await action(page.request, "saveStaff", {
      username,
      name: `角色验收${role}`,
      password: staffPassword,
      staffRole: role,
      active: true,
    });
    const context = await browser.newContext({ baseURL });
    const staff = await context.newPage();
    const errors: string[] = [];
    staff.on("pageerror", (error) => errors.push(error.message));
    try {
      await staffLogin(staff, username);
      await staff.goto(`/admin/orders?detail=${id}`);
      if (role === "warehouse") {
        await staff
          .getByRole("button", { name: "填写发货信息", exact: true })
          .click();
        const dialog = staff.getByRole("dialog", {
          name: "模拟发货",
          exact: true,
        });
        await dialog.getByRole("textbox").nth(0).fill("角色模拟物流");
        await dialog.getByRole("textbox").nth(1).fill(`ROLES-${suffix}`);
        const shipped = staff.waitForResponse((r) =>
          r.url().endsWith("/api/actions/shipOrder"),
        );
        await dialog
          .getByRole("button", { name: "确认模拟发货", exact: true })
          .click();
        expect((await shipped).ok()).toBe(true);
      } else {
        await expect(
          staff.getByRole("button", { name: "填写发货信息", exact: true }),
        ).toHaveCount(0);
        await action(
          page.request,
          "shipOrder",
          id,
          "角色模拟物流",
          `ROLES-${suffix}`,
        );
      }
      await action(page.request, "confirmOrder", id);
      const order = (
        await records<Order>(page.request, "orders", `role=user&id=${id}`)
      )[0]!;
      await action(page.request, "submitReview", {
        orderId: id,
        orderItemId: order.items[0]!.id,
        rating: 5,
        content: `角色验收评价${suffix}`,
      });
      await staff.goto(`/admin/orders?detail=${id}`);
      const reviewLink = staff.getByRole("link", {
        name: "查看该订单评价",
        exact: true,
      });
      if (role === "support") await expect(reviewLink).toBeVisible();
      else await expect(reviewLink).toHaveCount(0);
      await action(
        page.request,
        "requestAfterSale",
        id,
        "规格不合适",
        "各角色交接验收",
        [{ orderItemId: order.items[0]!.id, quantity: 1 }],
      );
      const sale = (
        await records<AfterSale>(
          page.request,
          "afterSales",
          `role=user&orderId=${id}`,
        )
      )[0]!;
      const openSale = async () => {
        await staff.goto(`/admin/after-sales?detail=${sale.id}`);
        await expect(staff.getByRole("dialog")).toContainText(sale.id);
      };
      await openSale();
      await expectActions(
        staff,
        role === "support" ? ["批准申请", "拒绝"] : [],
      );
      // The server must independently reject a valid action outside this role.
      const forbidden = await staff.request.post(
        "/api/actions/processAfterSale",
        {
          headers,
          data: {
            args: [sale.id, role === "support" ? "refund" : "approve"],
            requestId: randomUUID(),
          },
        },
      );
      expect(forbidden.status()).toBe(403);
      if (role === "support") await processSale(staff, "批准申请");
      else await action(page.request, "processAfterSale", sale.id, "approve");
      await action(
        page.request,
        "submitReturn",
        sale.id,
        "角色模拟退货",
        `RETURN-${suffix}`,
      );
      await openSale();
      await expectActions(staff, role === "warehouse" ? ["确认收到退货"] : []);
      if (role === "warehouse") await processSale(staff, "确认收到退货");
      else await action(page.request, "processAfterSale", sale.id, "receive");
      await openSale();
      await expectActions(staff, role === "finance" ? ["执行模拟退款"] : []);
      if (role === "finance") {
        await processSale(staff, "执行模拟退款");
        await staff.goto(`/admin/finance?q=${id}`);
        await expect(staff.locator(".el-table__body-wrapper")).toContainText(
          "退款",
        );
        await expect(staff.locator(".el-table__body-wrapper")).toContainText(
          id,
        );
        const download = staff.waitForEvent("download");
        await staff.getByRole("button", { name: /导出/ }).click();
        expect((await download).suggestedFilename()).toMatch(/\.csv$/);
      } else {
        await action(page.request, "processAfterSale", sale.id, "refund");
      }
      if (role === "warehouse") {
        await staff.goto("/admin/operations?tab=returnInspections");
        await staff
          .getByRole("row")
          .filter({ hasText: sale.id })
          .getByRole("button", { name: "质检", exact: true })
          .click();
        const inspection = staff.getByRole("dialog", {
          name: "退货质检",
          exact: true,
        });
        await inspection.getByLabel("良品", { exact: true }).fill("1");
        await inspection.getByLabel("次品", { exact: true }).fill("0");
        await inspection.getByRole("textbox").fill("验收良品");
        const inspected = staff.waitForResponse((r) =>
          r.url().endsWith("/api/actions/inspectReturn"),
        );
        await inspection
          .getByRole("button", { name: "登记质检", exact: true })
          .click();
        expect((await inspected).ok()).toBe(true);
      }
      if (role === "support") {
        const conversation = await action<string>(
          page.request,
          "createConversation",
        );
        await action(
          page.request,
          "sendMessage",
          conversation,
          "需要人工核对退货进度",
        );
        await action(page.request, "transferConversation", conversation);
        await staff.goto(`/admin/support?detail=${conversation}`);
        await staff
          .getByPlaceholder("输入人工回复。发送后会话转为人工接待。")
          .fill("已核对，退款已完成。");
        await staff
          .getByRole("button", { name: "发送回复", exact: true })
          .click();
        await expect(staff.locator(".admin-messages")).toContainText(
          "已核对，退款已完成。",
        );
        await page.goto(`/support?conversationId=${conversation}`);
        await expect(page.locator(".message-agent").last()).toContainText(
          "已核对，退款已完成。",
        );
      }
      const result = (
        await records<Order>(page.request, "orders", `role=user&id=${id}`)
      )[0]!;
      expect(result.status).toBe("refunded");
      expect(result.refundedAmount).toBe(result.total);
      expect(errors).toEqual([]);
      await staff.goto("/admin/coupons");
      await expect(staff).toHaveURL(/\/forbidden$/);
    } finally {
      await context.close();
    }
  });
}

test("运营可维护商品和活动，评价保持只读，越权页面与接口被拒绝", async ({
  page,
}) => {
  test.setTimeout(90000);
  await owner(page.request);
  const { id, suffix } = await paidOrder(page.request);
  await action(page.request, "shipOrder", id, "角色物流", suffix);
  await action(page.request, "confirmOrder", id);
  const order = (
    await records<Order>(page.request, "orders", `role=user&id=${id}`)
  )[0]!;
  await action(page.request, "submitReview", {
    orderId: id,
    orderItemId: order.items[0]!.id,
    rating: 5,
    content: `运营只读评价${suffix}`,
  });
  const username = `role_ops_${suffix}`;
  await action(page.request, "saveStaff", {
    username,
    name: "角色验收运营",
    password: staffPassword,
    staffRole: "operations" satisfies StaffRole,
    active: true,
  });
  await staffLogin(page, username);
  await page.goto(`/admin/reviews?orderId=${id}`);
  await expect(page.locator(".el-table__body-wrapper")).toContainText(
    `运营只读评价${suffix}`,
  );
  await expect(
    page.getByRole("button", { name: "隐藏评价", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "查看详情", exact: true }).click();
  await expect(
    page
      .getByRole("dialog")
      .getByRole("button", { name: "隐藏评价", exact: true }),
  ).toHaveCount(0);
  await page.goto("/admin/products");
  const row = page.locator(".el-table__body-wrapper tbody tr").first();
  await row.getByRole("button", { name: "编辑", exact: true }).click();
  const editor = page.getByRole("dialog");
  await editor.getByLabel("副标题", { exact: true }).fill("角色运营维护副标题");
  const saved = page.waitForResponse((r) =>
    r.url().endsWith("/api/actions/saveProduct"),
  );
  await editor.getByRole("button", { name: "保存商品", exact: true }).click();
  expect((await saved).ok()).toBe(true);
  await page.goto("/admin/operations?tab=promotions");
  await page.getByRole("button", { name: "新增满减活动", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("textbox")
    .first()
    .fill(`运营活动${suffix}`);
  await page.getByRole("dialog").getByRole("spinbutton").nth(0).fill("10000");
  await page.getByRole("dialog").getByRole("spinbutton").nth(1).fill("100");
  const promotion = page.waitForResponse((r) =>
    r.url().endsWith("/api/actions/savePromotion"),
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "保存", exact: true })
    .click();
  expect((await promotion).ok()).toBe(true);
  expect((await page.request.get("/api/admin/staff")).status()).toBe(403);
  await page.goto("/admin/inventory");
  await expect(page).toHaveURL(/\/forbidden$/);
});
