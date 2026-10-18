import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import type { Database } from "../../shared/domain/types";
import {
  openDatabase,
  readDatabase,
  writeDatabase,
} from "../../backend/src/database";
import { test, expect, TEST_ADMIN_PASSWORD } from "./fixtures";

function fixture<T>(change: (db: Database) => T): T {
  const sql = openDatabase(resolve("../backend/.e2e/shopmate.sqlite"));
  try {
    sql.exec("BEGIN IMMEDIATE");
    const db = readDatabase(sql),
      result = change(db);
    db.revision++;
    writeDatabase(sql, db);
    sql.exec("COMMIT");
    return result;
  } finally {
    sql.close();
  }
}
const rows = (page: Page) => page.locator(".el-table__body-wrapper tbody tr");
test.beforeEach(async ({ page }) => {
  test.skip(!!process.env.PLAYWRIGHT_BASE_URL, "后台体验回归仅使用隔离夹具");
  const response = await page.request.post("/api/auth/login", {
    headers: { "X-ShopMate-Request": "1" },
    data: { role: "admin", username: "admin", password: TEST_ADMIN_PASSWORD },
  });
  expect(response.ok()).toBe(true);
});

test("FAQ 搜索忽略首尾空格和英文大小写，记录与总数一致", async ({ page }) => {
  fixture((db) => {
    db.faqs.push({
      id: "ux-ai-faq",
      question: "AI 配送咨询",
      answer: "体验测试回复",
      keywords: ["AI", "咨询"],
      active: true,
    });
  });
  await page.goto(`/admin/knowledge?q=${encodeURIComponent(" ai ")}`);
  const faqRows = page
    .locator(".admin-panel")
    .first()
    .locator(".el-table__body-wrapper tbody tr");
  await expect(faqRows).toHaveCount(1);
  await expect(faqRows).toContainText("AI 配送咨询");
  await expect(page.getByText("1 条问答", { exact: true })).toBeVisible();
  await page.getByPlaceholder("搜索问题、回答或关键词").fill(" 配送 ");
  await expect(faqRows).toHaveCount(2);
  await expect(page.getByText("2 条问答", { exact: true })).toBeVisible();
});

test("经营工作台切换标签、历史导航和清空都同步搜索条件", async ({ page }) => {
  await page.goto("/admin/operations?tab=shippingRules");
  const search = page.getByPlaceholder("搜索当前业务记录");
  await search.fill("默认");
  await search.press("Enter");
  await expect(page).toHaveURL(/q=/);
  await expect(rows(page)).toContainText("默认免运费");
  await page.getByRole("button", { name: "满减活动", exact: true }).click();
  await expect(search).toHaveValue("");
  expect(new URL(page.url()).searchParams.get("q")).toBeNull();
  await page.goBack();
  await expect(search).toHaveValue("默认");
  await search.hover();
  await page.locator(".admin-toolbar .el-input__clear").click();
  await expect(search).toHaveValue("");
  await expect(page).not.toHaveURL(/q=/);
  await expect(rows(page)).toContainText("默认免运费");
  await search.fill("尚未提交的关键词");
  await page.getByRole("button", { name: "满减活动", exact: true }).click();
  await expect(search).toHaveValue("");
});

test("分类商品数包含已下架商品，和商品管理引用数量一致", async ({ page }) => {
  const expected = fixture((db) => {
    const category = db.categories[0]!;
    for (const product of db.products)
      if (product.categoryId === category.id) product.active = false;
    return {
      name: category.name,
      count: db.products.filter((product) => product.categoryId === category.id)
        .length,
    };
  });
  await page.goto("/admin/categories");
  await expect(
    page.getByRole("columnheader", { name: "商品数（含下架）" }),
  ).toBeVisible();
  const categoryRow = rows(page).filter({ hasText: expected.name });
  await expect(categoryRow.locator("td").nth(3)).toHaveText(
    String(expected.count),
  );
});

test("优惠券跨页保持服务端顺序，不再逐页倒置", async ({ page }) => {
  fixture((db) => {
    db.coupons = Array.from({ length: 12 }, (_, index) => ({
      id: `ux-coupon-${String(index).padStart(2, "0")}`,
      name: `排序体验券${index}`,
      threshold: 10000,
      discount: 1000,
      totalLimit: 100,
      active: true,
      claimStartsAt: new Date(Date.now() - 60000).toISOString(),
      claimEndsAt: new Date(Date.now() + 86400000).toISOString(),
      validFrom: new Date(Date.now() - 60000).toISOString(),
      validUntil: new Date(Date.now() + 86400000).toISOString(),
    }));
  });
  const first = await (
    await page.request.get("/api/collections/coupons?role=admin&pageSize=10")
  ).json();
  await page.goto("/admin/coupons");
  await expect(rows(page).locator("td:first-child .cell")).toHaveText(
    first.items.map((coupon: { name: string }) => coupon.name),
  );
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  const second = await (
    await page.request.get(
      "/api/collections/coupons?role=admin&pageSize=10&page=2",
    )
  ).json();
  await expect(rows(page).locator("td:first-child .cell")).toHaveText(
    second.items.map((coupon: { name: string }) => coupon.name),
  );
});

test("订单详情区分未付款应付金额、取消订单金额和实付金额", async ({ page }) => {
  const ids = fixture((db) => ({
    pending: db.orders.find((order) => order.status === "pending")!.id,
    cancelled: db.orders.find((order) => order.status === "cancelled")!.id,
    paid: db.orders.find((order) => order.status === "paid")!.id,
  }));
  for (const [status, label] of [
    ["pending", "应付金额"],
    ["cancelled", "订单金额"],
    ["paid", "实付金额"],
  ] as const) {
    await page.goto(`/admin/orders?detail=${ids[status]}`);
    const amount = page
      .getByRole("dialog", { name: "订单详情", exact: true })
      .locator(".admin-stats-line");
    await expect(amount).toContainText(label);
    if (status !== "paid") {
      await expect(amount).toContainText("未付款");
      await expect(amount).not.toContainText("实付金额");
    } else await expect(amount).not.toContainText("未付款");
  }
});

test("后台搜索长度限制与超长链接保护覆盖所有改动入口", async ({ page }) => {
  const failed: string[] = [];
  page.on("response", (response) => {
    if (response.url().includes("/api/") && response.status() >= 400)
      failed.push(response.url());
  });
  for (const path of [
    "products",
    "categories",
    "inventory",
    "orders",
    "after-sales",
    "finance",
    "coupons",
    "reviews",
    "support",
    "knowledge",
    "operations",
  ]) {
    await page.goto(`/admin/${path}?q=${encodeURIComponent("长".repeat(101))}`);
    await expect(
      page.locator(".admin-main input[maxlength='100']"),
    ).toHaveCount(1);
    expect(new URL(page.url()).searchParams.get("q")).toHaveLength(100);
  }
  await page.goto(
    `/admin/knowledge?q=${encodeURIComponent("a".repeat(99) + "😀")}&q=x`,
  );
  await expect(
    page.getByRole("button", { name: "新增问答", exact: true }),
  ).toBeEnabled();
  expect(new URL(page.url()).searchParams.getAll("q")).toEqual([
    "a".repeat(99),
  ]);
  expect(failed).toEqual([]);
});
