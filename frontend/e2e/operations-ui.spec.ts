import type { Page } from "@playwright/test";
import type {
  CheckoutQuote,
  Order,
  AfterSale,
} from "../../shared/domain/types";
import type { PurchaseOrder, Supplier } from "../../shared/domain/operations";
import {
  test,
  expect,
  TEST_ADMIN_PASSWORD,
  TEST_USER_PASSWORD,
} from "./fixtures";
const headers = { "X-ShopMate-Request": "1" };
async function login(page: Page) {
  const response = await page.request.post("/api/auth/login", {
    headers,
    data: { role: "admin", username: "admin", password: TEST_ADMIN_PASSWORD },
  });
  expect(response.ok()).toBe(true);
}
async function save(page: Page, method: string) {
  const response = page.waitForResponse(
    (entry) =>
      entry.url().endsWith(`/api/actions/${method}`) &&
      entry.request().method() === "POST",
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "保存", exact: true })
    .click();
  const value = await response;
  expect(value.ok(), await value.text()).toBe(true);
  await expect(page.getByRole("dialog")).not.toBeVisible();
}
test.beforeEach(() => {
  test.skip(
    !!process.env.PLAYWRIGHT_BASE_URL &&
      process.env.E2E_MUTATIONS_ALLOWED !== "1",
    "管理表单验收仅使用隔离夹具或显式允许写入的隔离部署",
  );
});

test("管理表单创建运费满减供应商并分批采购入库，金额库存一致", async ({
  page,
}) => {
  test.setTimeout(90000);
  await login(page);
  await page.goto("/admin/operations?tab=shippingRules");
  await page.getByRole("button", { name: "新增配送规则", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox").nth(0).fill("表单省份运费");
  await dialog.getByRole("textbox").nth(1).fill("浙江省");
  await dialog.getByRole("spinbutton").nth(0).fill("500");
  await dialog.getByRole("spinbutton").nth(1).fill("10000");
  await save(page, "saveShippingRule");
  await expect(page.locator(".el-table__body-wrapper")).toContainText(
    "表单省份运费",
  );
  await page.getByRole("button", { name: "满减活动", exact: true }).click();
  await page.getByRole("button", { name: "新增满减活动", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox").first().fill("表单满百减十");
  await dialog.getByRole("spinbutton").nth(0).fill("10000");
  await dialog.getByRole("spinbutton").nth(1).fill("1000");
  await save(page, "savePromotion");
  await expect(page.locator(".el-table__body-wrapper")).toContainText(
    "表单满百减十",
  );
  await page.getByRole("button", { name: "供应商", exact: true }).click();
  await page.getByRole("button", { name: "新增供应商", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox").nth(0).fill("表单采购供应商");
  await dialog.getByRole("textbox").nth(1).fill("13800000000");
  await save(page, "saveSupplier");
  const products = await (
    await page.request.get("/api/collections/products?role=admin&pageSize=1")
  ).json();
  const product = products.items[0],
    sku = product.skus[0],
    beforeStock = sku.stock;
  await page.getByRole("button", { name: "采购入库", exact: true }).click();
  await page.getByRole("button", { name: "新增采购单", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "采购草稿", exact: true });
  await dialog.getByRole("combobox").nth(0).fill("表单采购供应商");
  await page
    .getByRole("option", { name: "表单采购供应商", exact: true })
    .click();
  await dialog.getByRole("combobox").nth(1).fill(product.name);
  await page.getByRole("option", { name: product.name, exact: true }).click();
  await dialog.locator(".el-select").nth(2).click();
  await page.getByRole("option", { name: sku.name, exact: true }).click();
  await dialog.getByRole("spinbutton").nth(0).fill("3");
  await dialog.getByRole("spinbutton").nth(1).fill("500");
  const created = page.waitForResponse((entry) =>
    entry.url().endsWith("/api/actions/createPurchaseOrder"),
  );
  await dialog.getByRole("button", { name: "创建草稿", exact: true }).click();
  const result = await created;
  expect(result.ok(), await result.text()).toBe(true);
  const purchaseId = (await result.json()).result.id;
  await expect(dialog).not.toBeVisible();
  const row = page
    .locator(".el-table__body-wrapper tbody tr")
    .filter({ hasText: purchaseId });
  await row.getByRole("button", { name: "下单", exact: true }).click();
  await expect(row).toContainText("ordered");
  for (const quantity of [1, 2]) {
    await row.getByRole("button", { name: "分批入库", exact: true }).click();
    const receiving = page.getByRole("dialog", {
      name: "分批入库",
      exact: true,
    });
    await receiving.getByRole("spinbutton").fill(String(quantity));
    await receiving
      .getByRole("button", { name: "确认本次入库", exact: true })
      .click();
    await expect(receiving).not.toBeVisible();
  }
  await expect(row).toContainText("received");
  const after = await (
    await page.request.get(
      `/api/collections/products?role=admin&id=${product.id}`,
    )
  ).json();
  expect(
    after.items[0].skus.find((entry: { id: string }) => entry.id === sku.id)
      .stock,
  ).toBe(beforeStock + 3);
  const purchases = await (
    await page.request.get(
      `/api/collections/purchaseOrders?role=admin&id=${purchaseId}`,
    )
  ).json();
  expect(
    purchases.items[0].receipts.map(
      (entry: { amount: number }) => entry.amount,
    ),
  ).toEqual([500, 1000]);
});

test("员工表单设置仓储权限，越权导航关闭，停用后原会话失效", async ({
  page,
  browser,
  baseURL,
}) => {
  await login(page);
  await page.goto("/admin/operations?tab=staff");
  await page.getByRole("button", { name: "新增员工", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox").nth(0).fill("验收仓管");
  await dialog.getByRole("textbox").nth(1).fill("warehouse_ui");
  await dialog.locator('input[type="password"]').fill("WarehouseUI123!");
  await dialog.locator(".el-select").click();
  await page.getByRole("option", { name: "warehouse", exact: true }).click();
  await save(page, "saveStaff");
  const context = await browser.newContext({ baseURL });
  try {
    const staff = await context.newPage();
    expect(
      (
        await staff.request.post("/api/auth/login", {
          headers,
          data: {
            role: "admin",
            username: "warehouse_ui",
            password: "WarehouseUI123!",
          },
        })
      ).ok(),
    ).toBe(true);
    await staff.goto("/admin/inventory");
    await expect(
      staff.getByRole("heading", { name: "库存管理", exact: true }),
    ).toBeVisible();
    await expect(staff.getByRole("link", { name: /员工权限/ })).toHaveCount(0);
    expect((await staff.request.get("/api/admin/staff")).status()).toBe(403);
    await staff.goto("/admin/products");
    await expect(staff).toHaveURL(/\/forbidden$/);
    await page
      .locator(".el-table__body-wrapper tbody tr")
      .filter({ hasText: "warehouse_ui" })
      .getByRole("button", { name: "编辑", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .locator(".el-checkbox")
      .filter({ hasText: "启用" })
      .click();
    await expect(
      page
        .getByRole("dialog")
        .getByRole("checkbox", { name: "启用", exact: true }),
    ).not.toBeChecked();
    await save(page, "saveStaff");
    await staff.goto("/admin/inventory");
    await expect(staff).toHaveURL(/\/admin\/login\?redirect=/);
  } finally {
    await context.close();
  }
});

test("切换管理员清除员工密码、收货草稿和质检草稿，旧读取不能重新填回", async ({
  page,
  context,
}) => {
  test.setTimeout(90000);
  await login(page);
  const unique = crypto.randomUUID().replaceAll("-", "").slice(0, 10),
    ownerUsername = `owner_ctx_${unique}`;
  async function action<T>(method: string, ...args: unknown[]): Promise<T> {
    const response = await page.request.post(`/api/actions/${method}`, {
      headers,
      data: { args, requestId: crypto.randomUUID() },
    });
    expect(response.ok(), await response.text()).toBe(true);
    return (await response.json()).result as T;
  }
  await action("saveStaff", {
    username: ownerUsername,
    name: "备用店主",
    password: "OwnerContext123!",
    staffRole: "owner",
    active: true,
  });
  const other = await context.newPage();
  async function switchActor(second: boolean) {
    expect(
      (
        await other.request.post("/api/auth/login", {
          headers,
          data: {
            role: "admin",
            username: second ? ownerUsername : "admin",
            password: second ? "OwnerContext123!" : TEST_ADMIN_PASSWORD,
          },
        })
      ).ok(),
    ).toBe(true);
    await expect(page.locator(".admin-topbar")).toContainText(
      second ? "备用店主" : "商城管理员",
    );
  }
  try {
    await page.goto("/admin/operations?tab=staff");
    await page.getByRole("button", { name: "新增员工", exact: true }).click();
    await page
      .getByRole("dialog")
      .locator('input[type="password"]')
      .fill("OwnerA-Private-Draft!");
    await switchActor(true);
    await expect(page.getByRole("dialog")).not.toBeVisible();
    expect(await page.locator('input[type="password"]').inputValue()).toBe("");
    const supplier = await action<Supplier>("saveSupplier", {
      name: "身份隔离供应商",
      contact: "",
      active: true,
      version: 0,
    });
    const purchase = await action<PurchaseOrder>("createPurchaseOrder", {
      supplierId: supplier.id,
      lines: [{ productId: "p01", skuId: "p01-s1", quantity: 2, unitCost: 0 }],
    });
    await action("orderPurchase", purchase.id, purchase.version);
    await page.goto("/admin/operations?tab=purchaseOrders");
    await page
      .locator(".el-table__body-wrapper tbody tr")
      .filter({ hasText: purchase.id })
      .getByRole("button", { name: "分批入库", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "分批入库", exact: true })
      .getByRole("spinbutton")
      .fill("1");
    await switchActor(false);
    await expect(page.getByRole("dialog")).not.toBeVisible();
    const persisted = await (
      await page.request.get(
        `/api/collections/purchaseOrders?role=admin&id=${purchase.id}`,
      )
    ).json();
    expect(persisted.items[0].receipts).toEqual([]);
    expect(
      (
        await page.request.post("/api/auth/register", {
          headers,
          data: {
            username: `member_ctx_${unique}`,
            name: "隔离验收买家",
            password: TEST_USER_PASSWORD,
          },
        })
      ).ok(),
    ).toBe(true);
    await action("saveAddress", {
      name: "隔离验收买家",
      phone: "13800000000",
      province: "上海市",
      region: "上海市 徐汇区",
      detail: "隔离验收地址1号",
      isDefault: true,
    });
    const addresses = await (
      await page.request.get("/api/collections/addresses?role=user")
    ).json();
    const quote = await action<CheckoutQuote>("quoteCheckout", {
      source: {
        type: "buyNow",
        productId: "p01",
        skuId: "p01-s1",
        quantity: 1,
      },
      addressId: addresses.items[0].id,
    });
    const orderId = await action<string>("createOrder", {
      quoteId: quote.id,
      requestId: crypto.randomUUID(),
    });
    await action("payOrder", orderId);
    await action("shipOrder", orderId, "模拟物流", "CONTEXT-RETURN");
    const order = (
      await (
        await page.request.get(`/api/collections/orders?id=${orderId}`)
      ).json()
    ).items[0] as Order;
    await action(
      "requestAfterSale",
      orderId,
      "身份隔离验收",
      "退货质检草稿不应跨管理员",
      [{ orderItemId: order.items[0]!.id, quantity: 1 }],
    );
    const afterSale = (
      await (
        await page.request.get(`/api/collections/afterSales?orderId=${orderId}`)
      ).json()
    ).items[0] as AfterSale;
    await action("processAfterSale", afterSale.id, "approve");
    await action("submitReturn", afterSale.id, "模拟物流", "CONTEXT-RETURN");
    await action("processAfterSale", afterSale.id, "receive");
    await page.goto("/admin/operations?tab=returnInspections");
    await page.getByRole("button", { name: "质检", exact: true }).click();
    await page
      .getByRole("dialog", { name: "退货质检", exact: true })
      .getByRole("textbox")
      .fill("OwnerA-Private-Quality-Note");
    await switchActor(true);
    await expect(page.getByRole("dialog")).not.toBeVisible();
    expect(
      await page
        .locator("input")
        .evaluateAll((inputs) => inputs.map((input) => input.value)),
    ).not.toContain("OwnerA-Private-Quality-Note");
    await page.getByRole("button", { name: "质检", exact: true }).click();
    await expect(
      page
        .getByRole("dialog", { name: "退货质检", exact: true })
        .getByRole("textbox"),
    ).toHaveValue("");
  } finally {
    await other.close();
  }
});
