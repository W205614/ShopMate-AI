import { readSnapshot } from "./api-snapshot";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import type { Database } from "../../shared/domain/types";
import { test, expect, TEST_ADMIN_PASSWORD } from "./fixtures";

// All business writes below go through real UI. GETs only collect evidence.
test("双独立身份真实界面完成用券购买、故障恢复、分批退款履约评价及再次购买", async ({
  browser,
  baseURL,
}, info) => {
  test.skip(
    !!process.env.PLAYWRIGHT_BASE_URL &&
      process.env.E2E_MUTATIONS_ALLOWED !== "1",
    "写入式联合验收只用于明确允许的隔离部署",
  );
  test.setTimeout(240000);
  const adminContext = await browser.newContext({
    baseURL,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    viewport: { width: 1440, height: 1000 },
  });
  const userContext = await browser.newContext({
    baseURL,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    viewport: { width: 390, height: 900 },
  });
  const admin = await adminContext.newPage(),
    user = await userContext.newPage(),
    errors: string[] = [];
  for (const page of [admin, user])
    page.on("pageerror", (error) => errors.push(error.message));
  const read = async (page: Page, role = "admin"): Promise<Database> => {
    return (await readSnapshot(page.request, role)).db;
  };
  const screenshot = async (page: Page, name: string) => {
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
      name,
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath(`${name}.png`),
      fullPage: true,
      animations: "disabled",
    });
  };
  const confirm = async (name: string) => {
    await admin
      .getByRole("dialog", { name: "售后处理", exact: true })
      .getByRole("button", { name, exact: true })
      .click();
    await admin
      .locator(".el-message-box")
      .getByRole("button", { name: "确定", exact: true })
      .click();
  };
  const unique = randomUUID().replaceAll("-", "").slice(0, 10),
    username = `joint_${unique}`;
  const productName = `联合${unique} 长名称日常用品套装含多种规格与使用说明`,
    couponName = `联合${unique} 满减券`;
  const reviewText = `联合${unique}：购买后信息清晰，部分退款后的剩余商品正常收货，评价按实际购买保留。`;
  try {
    await admin.goto("/admin/login");
    await admin.getByLabel("账号", { exact: true }).fill("admin");
    await admin.getByLabel("密码", { exact: true }).fill(TEST_ADMIN_PASSWORD);
    await admin.getByRole("button", { name: "登录", exact: true }).click();
    await expect(admin).toHaveURL(/\/admin$/);
    const baseline = await read(admin);
    await user.goto("/register");
    await user.getByLabel("账号", { exact: true }).fill(username);
    await user.getByLabel("昵称", { exact: true }).fill("联合验收买家");
    await user.getByLabel("密码", { exact: true }).fill("JointCustomer123!");
    await user
      .getByLabel("确认密码", { exact: true })
      .fill("JointCustomer123!");
    await user.getByRole("button", { name: "注册并登录", exact: true }).click();
    await expect(user).toHaveURL(/\/$/);
    expect(
      (await readSnapshot(user.request, "user")).sessions.admin,
    ).toBeNull();
    expect(
      (await readSnapshot(admin.request, "admin")).sessions.user,
    ).toBeNull();

    await admin.goto("/admin/products");
    await admin.getByRole("button", { name: "新建商品", exact: true }).click();
    const productDialog = admin.getByRole("dialog", {
      name: "新建商品",
      exact: true,
    });
    await productDialog
      .getByLabel("商品名称", { exact: true })
      .fill(productName);
    await productDialog
      .getByLabel("副标题", { exact: true })
      .fill("隔离联合验收商品，长文字在移动设备上应清晰展示");
    await productDialog
      .getByLabel("材质 / 产品说明", { exact: true })
      .fill("模拟商品材质及使用说明");
    await productDialog
      .getByLabel("商品描述", { exact: true })
      .fill(
        "本商品仅用于隔离验收，用于验证规格、报价、优惠分摊、退款、履约与评价联动。",
      );
    await productDialog
      .getByLabel("商品图片内置路径", { exact: true })
      .fill("/images/p01.jpg");
    await productDialog
      .getByRole("button", { name: "添加内置图片", exact: true })
      .click();
    await productDialog
      .locator(".admin-sku-row")
      .getByRole("textbox")
      .first()
      .fill("标准套装含说明书及配件");
    await productDialog
      .getByLabel("售价（元）", { exact: true })
      .fill("100.001");
    await productDialog
      .locator(".admin-sku-row")
      .getByRole("spinbutton")
      .fill("7");
    await productDialog
      .getByRole("button", { name: "保存商品", exact: true })
      .click();
    await expect(
      admin.getByText("金额请以元填写，最多两位小数", { exact: true }),
    ).toBeVisible();
    await expect(
      productDialog.getByLabel("商品名称", { exact: true }),
    ).toHaveValue(productName);
    await admin.setViewportSize({ width: 390, height: 900 });
    const saveProduct = productDialog.getByRole("button", {
      name: "保存商品",
      exact: true,
    });
    await saveProduct.scrollIntoViewIfNeeded();
    await saveProduct.focus();
    await expect(saveProduct).toBeFocused();
    await screenshot(admin, "admin-product-actions-phone");
    await admin.setViewportSize({ width: 768, height: 1000 });
    await screenshot(admin, "admin-product-draft-tablet");
    await productDialog
      .getByLabel("售价（元）", { exact: true })
      .fill("100.01");
    await productDialog
      .getByRole("button", { name: "保存商品", exact: true })
      .click();
    await expect(productDialog).not.toBeVisible();
    const product = (await read(admin)).products.find(
      (p) => p.name === productName,
    )!;
    expect(product.skus[0]).toMatchObject({ price: 10001, stock: 7 });

    await admin.goto("/admin/coupons");
    await admin
      .getByRole("button", { name: "创建优惠券", exact: true })
      .click();
    const couponDialog = admin.getByRole("dialog", {
      name: "创建优惠券",
      exact: true,
    });
    await couponDialog
      .getByLabel("优惠券名称", { exact: true })
      .fill(couponName);
    await couponDialog
      .getByLabel("使用门槛（元）", { exact: true })
      .fill("100");
    await couponDialog
      .getByLabel("减免金额（元）", { exact: true })
      .fill("10.01");
    const localTime = (time: number) =>
      new Intl.DateTimeFormat("sv-SE", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
        .format(new Date(time))
        .replace(" ", "T");
    for (const label of ["领取开始", "使用开始"])
      await couponDialog
        .getByLabel(label, { exact: true })
        .fill(localTime(Date.now() - 3600000));
    for (const label of ["领取结束", "使用结束"])
      await couponDialog
        .getByLabel(label, { exact: true })
        .fill(localTime(Date.now() + 86400000));
    await couponDialog.getByLabel("总发行量", { exact: true }).fill("1");
    await couponDialog
      .getByRole("button", { name: "保存优惠券", exact: true })
      .click();
    await expect(couponDialog).not.toBeVisible();
    const coupon = (await read(admin)).coupons.find(
      (c) => c.name === couponName,
    )!;
    await user.goto("/coupons");
    const couponCard = user
      .locator(".commerce-coupon")
      .filter({ hasText: couponName });
    await couponCard
      .getByRole("button", { name: "立即领取", exact: true })
      .click();
    await expect(
      couponCard.getByRole("button", { name: "已领取", exact: true }),
    ).toBeDisabled();
    const claim = (await read(user, "user")).couponClaims.find(
      (c) => c.couponId === coupon.id,
    )!;
    await user.goto(`/products/${product.id}`);
    await user
      .getByRole("spinbutton", { name: "购买数量", exact: true })
      .fill("3");
    await user.getByRole("button", { name: "立即购买", exact: true }).click();
    await user.getByRole("button", { name: "添加地址", exact: true }).click();
    await user
      .getByLabel("收货人", { exact: true })
      .fill("联合验收长姓名收货人");
    await user.getByLabel("联系电话", { exact: true }).fill("123");
    await user.getByLabel("配送省份", { exact: true }).fill("上海市");
    await user
      .getByLabel("省 / 市 / 区", { exact: true })
      .fill("上海市 徐汇区 长地址分区");
    await user
      .getByLabel("详细地址", { exact: true })
      .fill(
        "联合验收大街一百零一号科研办公园区东门第三栋二十一层转角长地址收货点，请按门牌联系收货人。",
      );
    await user.getByRole("button", { name: "保存地址", exact: true }).click();
    await expect(user.getByLabel("联系电话", { exact: true })).toBeFocused();
    expect((await read(user, "user")).addresses).toHaveLength(0);
    await user.getByLabel("联系电话", { exact: true }).fill("13800000000");
    await user.getByRole("button", { name: "保存地址", exact: true }).click();
    await user.getByLabel("使用优惠券", { exact: true }).selectOption(claim.id);
    await expect(user.locator(".summary-total")).toContainText("¥290.02");
    await user.getByLabel("使用优惠券", { exact: true }).focus();
    await expect(user.getByLabel("使用优惠券", { exact: true })).toBeFocused();
    await user.keyboard.press("Tab");
    await expect(
      user.getByLabel("使用优惠券", { exact: true }),
    ).not.toBeFocused();
    await screenshot(user, "checkout-coupon-phone");
    let creates = 0;
    let checkoutRequest: { quoteId: string; requestId: string };
    await user.route("**/api/actions/createOrder", async (route) => {
      creates++;
      checkoutRequest = route.request().postDataJSON().args[0];
      expect((await route.fetch()).ok()).toBe(true);
      await route.abort("failed");
    });
    await user.getByRole("button", { name: "提交订单", exact: true }).click();
    await expect(
      user.getByRole("alert").filter({ hasText: "结果暂无法确认" }).first(),
    ).toBeVisible();
    await user.reload();
    await expect(user).toHaveURL(/\/orders\/[^/]+\/pay$/);
    const orderId = new URL(user.url()).pathname.split("/")[2]!;
    expect(creates).toBe(1);
    await user.unroute("**/api/actions/createOrder");
    await user
      .getByRole("button", { name: "确认模拟支付", exact: true })
      .click();
    await expect(
      user.getByRole("heading", { name: "模拟支付成功", exact: true }),
    ).toBeVisible();
    await user.getByRole("link", { name: "查看订单", exact: true }).click();

    async function refundOne(index: number) {
      await user.goto(`/orders/${orderId}`);
      await user.getByRole("button", { name: "申请售后", exact: true }).click();
      await user
        .getByRole("spinbutton", {
          name: `${productName} 售后数量`,
          exact: true,
        })
        .fill("1");
      await user
        .getByLabel("问题说明", { exact: true })
        .fill(`联合${unique} 第${index}次按数量退款，核对优惠分摊尾差`);
      await user.getByRole("button", { name: "提交申请", exact: true }).click();
      await expect
        .poll(
          async () =>
            (await read(admin)).afterSales.filter(
              (a) => a.orderId === orderId && a.status === "requested",
            ).length,
        )
        .toBe(1);
      const sale = (await read(admin)).afterSales.find(
        (a) => a.orderId === orderId && a.status === "requested",
      )!;
      expect(sale.requiresReturn).toBe(index !== 1);
      await admin.goto(`/admin/after-sales?detail=${sale.id}`);
      await admin
        .getByPlaceholder("填写审核或收货情况；拒绝时必填")
        .fill(`第${index}次：核对该购买行数量和原优惠分摊`);
      await confirm("批准申请");
      await expect(
        admin.getByRole("dialog", { name: "售后处理", exact: true }),
      ).toContainText("已批准");
      if (sale.requiresReturn) {
        await user.goto("/after-sales");
        const block = user.locator(".order-block").filter({ hasText: sale.id });
        await block
          .getByLabel("模拟退货承运商", { exact: true })
          .fill("模拟联合快递");
        await block
          .getByLabel("模拟退货单号", { exact: true })
          .fill(`JOINT-IN-${unique}-${index}`);
        await block
          .getByRole("button", { name: "提交退货单号", exact: true })
          .click();
        await expect(block).toContainText("退货运输中");
        await expect(
          admin.getByRole("button", { name: "确认收到退货", exact: true }),
        ).toBeEnabled();
        await confirm("确认收到退货");
        await expect(
          admin.getByRole("dialog", { name: "售后处理", exact: true }),
        ).toContainText("已收货");
      }
      await confirm("执行模拟退款");
      await expect(
        admin.getByRole("dialog", { name: "售后处理", exact: true }),
      ).toContainText("已退款");
      return sale.refundAmount;
    }
    expect(await refundOne(1)).toBe(9667);
    await admin.goto(`/admin/orders?detail=${orderId}`);
    const orderDialog = admin.getByRole("dialog", {
      name: "订单详情",
      exact: true,
    });
    await expect(orderDialog).toContainText(
      "购买 3 件 · 已退 1 件 · 未退 2 件",
    );
    await expect(orderDialog).toContainText("待发货数量：2 件");
    await screenshot(admin, "partial-order-tablet");
    await orderDialog
      .getByRole("button", { name: "填写发货信息", exact: true })
      .click();
    const shipping = admin.getByRole("dialog", {
      name: "模拟发货",
      exact: true,
    });
    await shipping.getByLabel("物流公司", { exact: true }).fill("模拟联合快递");
    await shipping
      .getByLabel("物流单号", { exact: true })
      .fill(`JOINT-OUT-${unique}`);
    await shipping
      .getByRole("button", { name: "确认模拟发货", exact: true })
      .click();
    await expect(shipping).not.toBeVisible();
    await expect(
      user.getByRole("button", { name: "确认收货", exact: true }),
    ).toBeEnabled();
    await user.getByRole("button", { name: "确认收货", exact: true }).click();
    await expect(
      user.getByRole("heading", { name: "已完成", exact: true }),
    ).toBeVisible();
    await user.getByRole("link", { name: "评价商品", exact: true }).click();
    const reviewCard = user
      .locator(".commerce-list-card")
      .filter({ hasText: orderId });
    await reviewCard
      .getByRole("button", { name: "写评价", exact: true })
      .click();
    await reviewCard.getByLabel("评分", { exact: true }).selectOption("5");
    await reviewCard.getByLabel("评价内容", { exact: true }).fill(reviewText);
    await screenshot(user, "review-form-phone");
    await reviewCard
      .getByRole("button", { name: "发布评价", exact: true })
      .click();
    await expect(user.getByRole("status")).toContainText("评价已发布");
    await user.goto(`/products/${product.id}`);
    const publicRegion = user.getByRole("region", {
      name: "商品评价",
      exact: true,
    });
    await expect(publicRegion).toContainText(reviewText);
    const published = await (
      await user.request.get(`/api/products/${product.id}/reviews`)
    ).json();
    expect(published).toMatchObject({ total: 1, averageRating: 5 });
    expect(published.items[0].displayName).toBe("联**");
    expect(Object.keys(published.items[0]).sort()).toEqual([
      "content",
      "createdAt",
      "displayName",
      "id",
      "rating",
    ]);
    await admin.goto(`/admin/reviews?orderId=${orderId}`);
    const reviewRow = admin.locator(".el-table__body-wrapper tbody tr");
    await reviewRow
      .getByRole("button", { name: "隐藏评价", exact: true })
      .click();
    await expect(publicRegion).toContainText("0 条评价");
    await reviewRow
      .getByRole("button", { name: "恢复展示", exact: true })
      .click();
    await expect(publicRegion).toContainText("5.0 / 5 星");
    await screenshot(user, "public-review-phone");

    await admin.goto("/admin/products");
    await admin.getByPlaceholder("搜索商品名称").fill(productName);
    await expect(admin.locator(".el-table__body-wrapper tbody tr")).toHaveCount(
      1,
    );
    await admin
      .locator(".el-table__body-wrapper tbody tr")
      .getByRole("button", { name: "编辑", exact: true })
      .click();
    const edit = admin.getByRole("dialog", { name: "编辑商品", exact: true });
    await edit.getByLabel("售价（元）", { exact: true }).fill("120.01");
    await edit.getByRole("button", { name: "保存商品", exact: true }).click();
    await expect(edit).not.toBeVisible();
    const beforeReorder = await read(admin);
    await user.goto(`/orders/${orderId}`);
    await user.getByRole("button", { name: "再次购买", exact: true }).click();
    await expect(user.getByRole("status")).toContainText(
      "已加入 1 项，共 3 件",
    );
    await user.goto("/cart");
    await expect(user.getByRole("spinbutton")).toHaveValue("3");
    await expect(user.locator(".summary-total")).toContainText("¥360.03");
    await screenshot(user, "reorder-cart-phone");
    const reordered = await read(admin);
    expect(reordered.orders).toEqual(beforeReorder.orders);
    expect(reordered.inventory).toEqual(beforeReorder.inventory);
    expect(reordered.ledger).toEqual(beforeReorder.ledger);
    expect(
      reordered.products.find((p) => p.id === product.id)!.skus[0]!.stock,
    ).toBe(5);
    const refundAmounts = [9667, await refundOne(2), await refundOne(3)];
    expect(refundAmounts).toEqual([9667, 9667, 9668]);
    await user.goto(`/products/${product.id}`);
    await expect(publicRegion).toContainText("0 条评价");
    await admin.goto(`/admin/reviews?orderId=${orderId}`);
    await expect(reviewRow).toContainText("已全退，仅保留历史");
    await expect(
      reviewRow.getByRole("button", { name: "恢复展示", exact: true }),
    ).toHaveCount(0);

    const final = await read(admin),
      order = final.orders.find((o) => o.id === orderId)!;
    expect(order).toMatchObject({
      status: "refunded",
      total: 29002,
      discount: 1001,
      refundedAmount: 29002,
    });
    expect(order.items[0]).toMatchObject({
      quantity: 3,
      refundedQuantity: 3,
      total: 29002,
    });
    expect(final.couponClaims.find((c) => c.id === claim.id)?.status).toBe(
      "used",
    );
    expect(
      final.products.find((p) => p.id === product.id)!.skus[0]!.stock,
    ).toBe(5);
    expect(
      final.inventory
        .filter((m) => m.skuId === product.skus[0]!.id)
        .reduce((n, m) => n + m.delta, 0),
    ).toBe(5);
    expect(
      final.returnInspections!.filter(
        (i) => i.afterSaleId && i.productId === product.id,
      ),
    ).toEqual([
      expect.objectContaining({ quantity: 1, status: "pending", good: 0 }),
      expect.objectContaining({ quantity: 1, status: "pending", good: 0 }),
    ]);
    const payments = final.ledger.filter(
        (l) => l.reference === orderId && l.type === "payment",
      ),
      refunds = final.ledger.filter(
        (l) => l.reference === orderId && l.type === "refund",
      );
    expect(payments.map((l) => l.amount)).toEqual([29002]);
    expect(refunds.map((l) => l.amount).sort((a, b) => a - b)).toEqual([
      9667, 9667, 9668,
    ]);
    const recovered = await user.request.get(
      `/api/order-requests/${checkoutRequest!.requestId}?quoteId=${checkoutRequest!.quoteId}`,
    );
    expect(await recovered.json()).toEqual({ orderId });
    expect(
      final.orders.filter((o) =>
        o.items.some((i) => i.productId === product.id),
      ),
    ).toHaveLength(1);
    expect(
      final.inventory
        .filter((m) => m.skuId === product.skus[0]!.id)
        .map((m) => m.delta)
        .sort((a, b) => a - b),
    ).toEqual([-3, 1, 7]);
    const privateUser = await read(user, "user");
    for (const records of [
      privateUser.ledger,
      privateUser.inventory,
      privateUser.inventoryRequests,
    ])
      expect(records).toEqual([]);
    const publicBody = await (
      await user.request.get(`/api/products/${product.id}/reviews`)
    ).json();
    expect(publicBody).toMatchObject({ total: 0, averageRating: 0 });
    await admin.goto(`/admin/finance?q=${orderId}`);
    for (const label of ["收款", "退款"])
      await expect(
        admin
          .locator(".admin-kpi")
          .filter({ has: admin.getByText(label, { exact: true }) }),
      ).toContainText("¥290.02");
    await expect(
      admin.locator(".admin-kpi").filter({ hasText: "筛选范围净收支" }),
    ).toContainText("¥0.00");
    const download = admin.waitForEvent("download");
    await admin
      .getByRole("button", { name: "导出当前 CSV", exact: true })
      .click();
    const csv = await readFile((await (await download).path())!, "utf8");
    for (const amount of ["290.02", "96.67", "96.68"])
      expect(csv).toContain(`"${amount}"`);
    expect(csv.match(new RegExp(orderId, "g"))).toHaveLength(4);
    await screenshot(admin, "finance-tablet");
    await admin.goto("/admin");
    const sum = (db: Database, type: "payment" | "refund") =>
      db.ledger
        .filter((l) => l.type === type)
        .reduce((n, l) => n + BigInt(l.amount), 0n);
    expect(sum(final, "payment") - sum(baseline, "payment")).toBe(29002n);
    expect(sum(final, "refund") - sum(baseline, "refund")).toBe(29002n);
    for (const width of [390, 768, 1440]) {
      await admin.setViewportSize({ width, height: 1000 });
      await screenshot(admin, `dashboard-${width}`);
      await user.setViewportSize({ width, height: 1000 });
      await user.goto(`/orders/${orderId}`);
      await expect(
        user.getByRole("heading", { name: "已退款", exact: true }),
      ).toBeVisible();
      await screenshot(user, `refunded-order-${width}`);
    }
    expect(errors).toEqual([]);
    const evidence = JSON.stringify(
      {
        orderId,
        productId: product.id,
        creates,
        total: order.total,
        refunds: refundAmounts,
        finalStock: final.products.find((p) => p.id === product.id)!.skus[0]!
          .stock,
        inventorySum: final.inventory
          .filter((m) => m.skuId === product.skus[0]!.id)
          .reduce((n, m) => n + m.delta, 0),
        paymentCount: payments.length,
        refundCount: refunds.length,
        pageErrors: errors,
      },
      null,
      2,
    );
    await writeFile(
      info.outputPath("business-invariants.json"),
      evidence,
      "utf8",
    );
    await info.attach("business-invariants", {
      body: evidence,
      contentType: "application/json",
    });
  } finally {
    await adminContext.close();
    await userContext.close();
  }
});
