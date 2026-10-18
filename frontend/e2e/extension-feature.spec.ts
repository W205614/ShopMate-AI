import { randomUUID } from "node:crypto";
import { test, expect, TEST_ADMIN_PASSWORD } from "./fixtures";
import type {
  Address,
  Order,
  Product,
  AfterSale,
} from "../../shared/domain/types";
import type {
  Promotion,
  ReturnInspection,
} from "../../shared/domain/operations";

test("新经营规则贯通报价、预占、积分、退款隔离与质检入库", async ({ page }) => {
  test.skip(
    !!process.env.PLAYWRIGHT_BASE_URL &&
      process.env.E2E_MUTATIONS_ALLOWED !== "1",
    "仅在隔离环境执行写入验收",
  );
  const headers = { "X-ShopMate-Request": "1" };
  const request = page.request;
  async function action<T = void>(
    method: string,
    args: unknown[],
    requestId = randomUUID(),
  ): Promise<T> {
    const response = await request.post(`/api/actions/${method}`, {
      headers,
      data: { args, requestId },
    });
    expect(response.ok(), await response.text()).toBe(true);
    return (await response.json()).result as T;
  }
  async function records<T>(
    collection: string,
    role = "user",
    query = "",
  ): Promise<T[]> {
    const response = await request.get(
      `/api/collections/${collection}?role=${role}&pageSize=100${query}`,
    );
    expect(response.ok(), await response.text()).toBe(true);
    return (await response.json()).items as T[];
  }
  const unique = randomUUID().replaceAll("-", "").slice(0, 12);
  expect(
    (
      await request.post("/api/auth/register", {
        headers,
        data: {
          username: `rules_${unique}`,
          name: "规则验收买家",
          password: "Acceptance123!",
        },
      })
    ).status(),
  ).toBe(201);
  expect(
    (
      await request.post("/api/auth/login", {
        headers,
        data: {
          role: "admin",
          username: "admin",
          password: TEST_ADMIN_PASSWORD,
        },
      })
    ).ok(),
  ).toBe(true);
  const product = (await records<Product>("products", "admin")).find(
    (p) => p.active && p.skus.some((s) => s.stock >= 2),
  )!;
  const sku = product.skus.find((s) => s.stock >= 2)!;
  await action("saveAddress", [
    {
      name: "规则验收",
      phone: "13800000000",
      province: "上海市",
      region: "上海市 浦东新区",
      detail: "隔离验收地址",
      isDefault: true,
    },
  ]);
  const address = (await records<Address>("addresses"))[0]!;
  await action("saveShippingRule", [
    {
      name: `配送${unique}`,
      province: "上海市",
      enabled: true,
      fee: 801,
      freeAbove: 0,
      version: 0,
    },
  ]);
  await action<Promotion>("savePromotion", [
    {
      name: `满减${unique}`,
      threshold: sku.price,
      discount: 101,
      active: true,
      version: 0,
      startsAt: new Date(Date.now() - 60000).toISOString(),
      endsAt: new Date(Date.now() + 3600000).toISOString(),
    },
  ]);
  await page.goto(
    `/checkout?productId=${product.id}&skuId=${sku.id}&quantity=2`,
  );
  await expect(
    page.getByText(`优惠减免 · 满减${unique}`, { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(`配送费 · 配送${unique}`, { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("报价不占库存，提交订单后预占 30 分钟。", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "提交订单", exact: true }).click();
  await expect(page).toHaveURL(/\/orders\/[^/]+\/pay$/);
  const orderId = new URL(page.url()).pathname.split("/")[2]!;
  const original = (
    await records<Order>("orders", "user", `&id=${orderId}`)
  )[0]!;
  expect(original).toMatchObject({
    inventoryPolicy: "reserved-v1",
    shippingFee: 801,
    discount: 101,
    afterSaleDays: 7,
    address: { id: address.id },
  });
  expect(original.total).toBe(2 * sku.price - 101 + 801);
  const publicProduct = (
    await records<Product>("products", "user", `&id=${product.id}`)
  )[0]!;
  expect(publicProduct.skus.find((s) => s.id === sku.id)!.stock).toBe(
    sku.stock - 2,
  );
  const paymentKey = randomUUID();
  await action("payOrder", [orderId], paymentKey);
  await action("payOrder", [orderId], paymentKey);
  const recovered = await (
    await request.get(`/api/requests/${paymentKey}?method=payOrder&role=user`)
  ).json();
  expect(recovered.found).toBe(true);
  await action("shipOrder", [orderId, "模拟物流", "RULES-OUT"]);
  await action("confirmOrder", [orderId]);
  await page.goto("/points");
  const initialPoints = Math.floor((2 * sku.price - 101) / 100);
  await expect(
    page.getByText(`可用积分：${initialPoints}。`, { exact: false }),
  ).toBeVisible();
  await action("requestAfterSale", [
    orderId,
    "退一件",
    "隔离验收质检及积分冲回",
    [{ orderItemId: original.items[0]!.id, quantity: 1 }],
  ]);
  const sale = (
    await records<AfterSale>("afterSales", "user", `&orderId=${orderId}`)
  ).find((s) => s.status === "requested")!;
  await action("processAfterSale", [sale.id, "approve"]);
  await action("submitReturn", [sale.id, "退货物流", "RULES-IN"]);
  await action("processAfterSale", [sale.id, "receive"]);
  await action("processAfterSale", [sale.id, "refund"]);
  const beforeInspection = (
    await records<Product>("products", "admin", `&id=${product.id}`)
  )[0]!;
  expect(beforeInspection.skus.find((s) => s.id === sku.id)!.stock).toBe(
    sku.stock - 2,
  );
  const inspection = (
    await records<ReturnInspection>("returnInspections", "admin")
  ).find((i) => i.afterSaleId === sale.id)!;
  expect(inspection).toMatchObject({ status: "pending", good: 0, quantity: 1 });
  await page.goto("/admin/operations?tab=returnInspections");
  const row = page.getByRole("row").filter({ hasText: sale.id });
  await row.getByRole("button", { name: "质检", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "退货质检", exact: true });
  await dialog.getByLabel("良品", { exact: true }).fill("1");
  await dialog.getByLabel("次品", { exact: true }).fill("0");
  await dialog.getByLabel("质检说明", { exact: true }).fill("验收良品入库");
  await dialog.getByRole("button", { name: "登记质检", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const afterInspection = (
    await records<Product>("products", "admin", `&id=${product.id}`)
  )[0]!;
  expect(afterInspection.skus.find((s) => s.id === sku.id)!.stock).toBe(
    sku.stock - 1,
  );
  const afterRefund = (
    await records<Order>("orders", "user", `&id=${orderId}`)
  )[0]!;
  expect(afterRefund.shippingRefunded).toBe(0);
  await page.goto("/points");
  await expect(
    page.getByText(
      `可用积分：${Math.floor((original.items[0]!.total - sale.refundAmount) / 100)}。`,
      { exact: false },
    ),
  ).toBeVisible();
  expect(
    (await (await request.get("/api/admin/reconciliation")).json()).balanced,
  ).toBe(true);
  await page.goto("/admin/operations?tab=reconciliation");
  await expect(
    page.getByRole("heading", { name: "收支核对一致", exact: true }),
  ).toBeVisible();
});
