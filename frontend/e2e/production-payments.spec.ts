import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { resolve } from "node:path";
const control = {
  "X-Acceptance-Token": "shopmate-isolated-browser-fixture-control-token",
};
const headers = { "X-ShopMate-Request": "1" };
async function post(client: APIRequestContext, path: string, data: unknown) {
  const response = await client.post(path, { headers, data });
  expect(response.ok(), `${path}: ${await response.text()}`).toBe(true);
  return response.json();
}
async function registerAndOrder(page: Page) {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10),
    email = `pay_${suffix}@example.test`;
  const sent = await post(page.request, "/api/auth/verification/send", {
    channel: "email",
    target: email,
    purpose: "register",
  });
  const inbox = await (
    await page.request.get(
      `/__acceptance/control/inbox?target=${encodeURIComponent(email)}`,
      { headers: control },
    )
  ).json();
  const proof = await post(page.request, "/api/auth/verification/verify", {
    challengeId: sent.challengeId,
    code: inbox.at(-1).code,
  });
  const merchant = await (await page.request.get("/api/merchant")).json();
  await post(page.request, "/api/auth/register", {
    username: `pay_${suffix}`,
    name: "支付验收顾客",
    password: "BrowserPayment123!",
    verificationToken: proof.verificationToken,
    privacyVersion: merchant.privacy.version,
    termsVersion: merchant.terms.version,
  });
  await post(page.request, "/api/actions/saveAddress", {
    args: [
      {
        name: "合成顾客",
        phone: "13800000000",
        province: "上海市",
        region: "上海市 上海市 浦东新区",
        detail: "隔离验收地址",
        isDefault: true,
      },
    ],
    requestId: crypto.randomUUID(),
  });
  const addresses = await (
    await page.request.get("/api/collections/addresses?role=user")
  ).json();
  const quote = await post(page.request, "/api/actions/quoteCheckout", {
    args: [
      {
        addressId: addresses.items[0].id,
        source: {
          type: "buyNow",
          productId: "p01",
          skuId: "p01-s1",
          quantity: 1,
        },
      },
    ],
    requestId: crypto.randomUUID(),
  });
  const order = await post(page.request, "/api/actions/createOrder", {
    args: [{ quoteId: quote.result.id, requestId: crypto.randomUUID() }],
    requestId: crypto.randomUUID(),
  });
  return String(order.result);
}
async function channelPayments(client: APIRequestContext, orderId: string) {
  const result = await (
    await client.get("/__acceptance/control/payments", { headers: control })
  ).json();
  return {
    items: result.items.filter(
      (value: { orderId: string }) => value.orderId === orderId,
    ),
    calls: result.calls,
  };
}

test("desktop channel checkout survives refresh, switches only after closure and completes a pending refund", async ({
  page,
}) => {
  const orderId = await registerAndOrder(page);
  const historicalResponse = await page.request.post(
    `/__acceptance/control/orders/${orderId}/legacy-copy`,
    { headers: control },
  );
  expect(historicalResponse.status()).toBe(201);
  const historical = await historicalResponse.json();
  await page.goto(`/orders/${historical.id}/pay`);
  await expect(
    page.getByRole("heading", { name: "历史演示订单", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("该订单为历史演示数据，生产环境不提供模拟付款或真实退款。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /确认模拟支付|创建支付单/ }),
  ).toHaveCount(0);
  await page.goto(`/orders/${orderId}/pay`);
  await expect(
    page.getByRole("heading", { name: "订单付款", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "创建支付单", exact: true }).click();
  await expect(page.getByAltText("微信支付二维码")).toBeVisible();
  const before = await channelPayments(page.request, orderId),
    first = before.items[0];
  await page.reload();
  await expect(page.getByAltText("微信支付二维码")).toBeVisible();
  expect(
    (await channelPayments(page.request, orderId)).calls.wechatpay[
      `create:${first.id}`
    ],
  ).toBe(1);
  await page
    .getByRole("button", { name: "关闭支付单以切换渠道", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("支付单已关闭");
  await page.getByLabel("支付方式").selectOption("alipay_page");
  await page.getByRole("button", { name: "创建支付单", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "前往支付平台", exact: true }),
  ).toBeVisible();
  const active = (await channelPayments(page.request, orderId)).items.find(
    (value: { status: string }) => value.status === "pending",
  );
  await page.request.post(`/__acceptance/control/payments/${active.id}/state`, {
    headers: control,
    data: { status: "succeeded" },
  });
  await page.getByRole("button", { name: "查询付款结果", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "付款成功", exact: true }),
  ).toBeVisible();
  const orders = await (
    await page.request.get(`/api/collections/orders?role=user&id=${orderId}`)
  ).json();
  await post(page.request, "/api/actions/requestAfterSale", {
    args: [
      orderId,
      "不再需要",
      "合成退款验收",
      [{ orderItemId: orders.items[0].items[0].id, quantity: 1 }],
    ],
    requestId: crypto.randomUUID(),
  });
  const sales = await (
    await page.request.get(
      `/api/collections/afterSales?role=user&orderId=${orderId}`,
    )
  ).json();
  const saleId = sales.items[0].id;
  await page.request.get("/__acceptance/control/admin-session", {
    headers: control,
  });
  await post(page.request, "/api/actions/processAfterSale", {
    args: [saleId, "approve", "合成审核"],
    requestId: crypto.randomUUID(),
  });
  await page.goto(`/admin/after-sales?orderId=${orderId}&detail=${saleId}`);
  await page.getByRole("button", { name: "提交渠道退款", exact: true }).click();
  await page.getByRole("button", { name: "确定", exact: true }).click();
  await expect(
    page.getByText(/已受理，请在生产接入页面核对渠道结果/),
  ).toBeVisible();
  const refunds = await (await page.request.get("/api/admin/refunds")).json();
  const refund = refunds.items.find(
    (value: { afterSaleId: string }) => value.afterSaleId === saleId,
  );
  expect(refund.status).toBe("processing");
  await page.request.post(`/__acceptance/control/refunds/${refund.id}/state`, {
    headers: control,
    data: { status: "succeeded" },
  });
  await page.goto(`/orders/${orderId}`);
  await expect(
    page.getByRole("heading", { name: "已退款", exact: true }),
  ).toBeVisible();
});

test("production catalog uploads and saves server-backed images, and records real shipping information", async ({
  page,
}) => {
  const orderId = await registerAndOrder(page);
  const payment = await post(page.request, "/api/payments", {
    orderId,
    channel: "wechat_native",
    requestId: crypto.randomUUID(),
  });
  await page.request.post(
    `/__acceptance/control/payments/${payment.id}/state`,
    { headers: control, data: { status: "succeeded" } },
  );
  await page.request.get("/__acceptance/control/admin-session", {
    headers: control,
  });
  await post(page.request, "/api/actions/shipOrder", {
    args: [orderId, "顺丰速运", "SFTEST000001"],
    requestId: crypto.randomUUID(),
  });
  await page.goto(`/orders/${orderId}`);
  await expect(page.getByText("顺丰速运 · SFTEST000001")).toBeVisible();
  await expect(page.getByText(/尚未启用在线轨迹查询/)).toBeVisible();
  await page.goto("/admin/products");
  await page
    .locator(".el-table__body-wrapper tbody tr")
    .first()
    .getByRole("button", { name: "编辑", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "编辑商品" });
  const uploadResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/assets") &&
      response.request().method() === "POST",
  );
  await dialog
    .getByLabel("上传商品图片", { exact: true })
    .setInputFiles(resolve("public/images/p01.jpg"));
  const response = await uploadResponse;
  expect(response.status()).toBe(201);
  const asset = await response.json();
  await expect(dialog.locator(`img[src="${asset.url}"]`)).toBeVisible();
  await dialog.getByRole("button", { name: "保存商品", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect((await page.request.get(asset.url)).ok()).toBe(true);
});

test.describe("mobile browser payments", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    userAgent:
      "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36",
  });
  test("renews expired H5 checkout on the original payment before switching to WAP and confirming payment", async ({
    page,
  }) => {
    const orderId = await registerAndOrder(page);
    await page.goto(`/orders/${orderId}/pay`);
    await expect(page.getByLabel("支付方式")).toBeVisible();
    await page.getByLabel("支付方式").selectOption("wechat_h5");
    await page.getByRole("button", { name: "创建支付单", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "前往支付平台", exact: true }),
    ).toBeVisible();
    const before = await channelPayments(page.request, orderId);
    const original = before.items[0];
    expect(original.checkout.expiresAt).toBeTruthy();
    expect(
      (
        await page.request.post(
          `/__acceptance/control/payments/${original.id}/expire-checkout`,
          { headers: control },
        )
      ).ok(),
    ).toBe(true);
    await page
      .getByRole("button", { name: "前往支付平台", exact: true })
      .click();
    await expect(page).toHaveURL(
      new RegExp(
        `/__acceptance/checkout/${original.id}\\?revision=${before.calls.wechatpay[`create:${original.id}`] + 1}$`,
      ),
    );
    const refreshed = await channelPayments(page.request, orderId);
    expect(refreshed.calls.wechatpay[`create:${original.id}`]).toBe(
      before.calls.wechatpay[`create:${original.id}`] + 1,
    );
    expect(refreshed.calls.wechatpay[`query:${original.id}`]).toBe(
      (before.calls.wechatpay[`query:${original.id}`] ?? 0) + 1,
    );
    expect(refreshed.items).toHaveLength(1);
    expect(refreshed.items[0]).toMatchObject({
      id: original.id,
      status: "pending",
    });
    expect(Date.parse(refreshed.items[0].checkout.expiresAt)).toBeGreaterThan(
      Date.now(),
    );
    expect(refreshed.items[0].checkout.value).not.toBe(original.checkout.value);
    await expect(page).toHaveURL(refreshed.items[0].checkout.value);
    await page.goto(`/orders/${orderId}/pay`);
    await page
      .getByRole("button", { name: "关闭支付单以切换渠道", exact: true })
      .click();
    await expect(page.getByRole("status")).toContainText("支付单已关闭");
    await page.getByLabel("支付方式").selectOption("alipay_wap");
    await page.getByRole("button", { name: "创建支付单", exact: true }).click();
    const switched = await channelPayments(page.request, orderId);
    expect(
      switched.items.find((value: { id: string }) => value.id === original.id)
        .status,
    ).toBe("closed");
    const active = switched.items.find(
      (value: { status: string }) => value.status === "pending",
    );
    await page
      .getByRole("button", { name: "前往支付平台", exact: true })
      .click();
    await expect(page).toHaveURL(
      new RegExp(`/__acceptance/checkout/${active.id}$`),
    );
    await page.request.post(
      `/__acceptance/control/payments/${active.id}/state`,
      { headers: control, data: { status: "succeeded" } },
    );
    await page.goto(`/orders/${orderId}/pay`);
    await expect(
      page.getByRole("heading", { name: "付款成功", exact: true }),
    ).toBeVisible();
  });
});

test("channel reconciliation exposes supplier differences and persists an operator review while internal accounting remains independent", async ({
  page,
}) => {
  const date = "2020-01-02";
  const merchantOrderNo = `SMp${crypto.randomUUID().replaceAll("-", "").slice(0, 28)}`;
  const configured = await page.request.post("/__acceptance/control/bills", {
    headers: control,
    data: {
      provider: "wechatpay",
      date,
      rows: [{ kind: "payment", merchantOrderNo, amount: 100, fee: 3 }],
    },
  });
  expect(configured.ok()).toBe(true);
  await page.request.get("/__acceptance/control/admin-session", {
    headers: control,
  });
  await page.goto("/admin/production?tab=reconciliation");
  await page.getByRole("tab", { name: "渠道对账", exact: true }).click();
  await page.locator(".production-panel .el-select").click();
  await page.getByRole("option", { name: "微信支付", exact: true }).click();
  await page.getByRole("textbox", { name: "账单日期", exact: true }).fill(date);
  const submission = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/admin/channel-reconciliation") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "拉取并核对", exact: true }).click();
  const response = await submission;
  expect(response.status()).toBe(202);
  const report = await response.json();
  await expect(
    page.getByRole("alert").filter({ hasText: "对账任务已提交" }),
  ).toBeVisible();
  const row = page
    .locator(".el-table__body-wrapper tbody tr")
    .filter({ hasText: date })
    .filter({ hasText: "wechatpay" });
  await expect(row).toContainText("等待处理");
  expect(
    (
      await page.request.post("/__acceptance/control/tick", {
        headers: control,
      })
    ).ok(),
  ).toBe(true);
  await page.reload();
  await page.getByRole("tab", { name: "渠道对账", exact: true }).click();
  await expect(row).toContainText("已完成");
  await expect(row.getByRole("cell").nth(3)).toHaveText("1");
  await expect(row).toContainText("未复核");
  await row.getByRole("button", { name: "查看明细", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: `账单明细 ${report.id}`, exact: true }),
  ).toBeVisible();
  const detail = page.getByRole("row").filter({ hasText: merchantOrderNo });
  await expect(detail).toContainText("CHANNEL_ONLY");
  await expect(detail.getByRole("cell").nth(3)).toHaveText("—");
  await expect(detail.getByRole("cell").nth(4)).toContainText("1.00");
  await expect(detail.getByRole("cell").nth(5)).toContainText("0.03");
  await expect(
    row.getByRole("button", { name: "记录复核", exact: true }),
  ).toBeDisabled();
  const note =
    "已核实为渠道孤立流水，保留差异并交商户平台核查，不补记虚构收入。";
  await page.getByLabel(`复核说明 ${report.id}`, { exact: true }).fill(note);
  await row.getByRole("button", { name: "记录复核", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "已记录人工复核" }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("tab", { name: "渠道对账", exact: true }).click();
  await expect(row).toContainText("已复核");
  const persisted = await (
    await page.request.get("/__acceptance/control/reconciliation", {
      headers: control,
    })
  ).json();
  expect(
    persisted.reports.find((value: { id: string }) => value.id === report.id),
  ).toMatchObject({
    status: "done",
    differences: 1,
    reviewed: 1,
    review_note: note,
  });
  expect(persisted.billCalls.wechatpay[`bill:${date}`]).toBe(1);
  const internal = await page.request.get("/api/admin/reconciliation");
  expect(internal.ok()).toBe(true);
  expect(await internal.json()).toMatchObject({
    balanced: true,
    issues: [],
    totals: expect.any(Object),
  });
});
