import type { Page } from "@playwright/test";
import { test, expect, TEST_ADMIN_PASSWORD } from "./fixtures";
test("商品和分类保存中阻止关闭弹窗，旧响应不会关闭新的编辑草稿", async ({
  page,
}) => {
  for (const [path, title, method] of [
    ["products", "商品", "saveProduct"],
    ["categories", "分类", "saveCategory"],
  ]) {
    await page.goto(`/admin/${path}`);
    await page
      .locator(".el-table__body-wrapper tbody tr")
      .first()
      .getByRole("button", { name: "编辑", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: `编辑${title}` });
    let release!: () => void, observed!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      observed = resolve;
    });
    await page.route(`**/api/actions/${method}`, async (route) => {
      const response = await route.fetch();
      observed();
      await held;
      await route.fulfill({ response });
    });
    await dialog
      .getByRole("button", {
        name: title === "商品" ? "保存商品" : "保存",
        exact: true,
      })
      .click();
    await started;
    try {
      await expect(
        dialog.getByRole("button", { name: "取消", exact: true }),
      ).toBeDisabled();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeVisible();
    } finally {
      release();
    }
    await expect(dialog).not.toBeVisible();
    await page.unroute(`**/api/actions/${method}`);
  }
});
test("选图预检在 FileReader 前拒绝数量和总量超限并保留原图", async ({
  page,
}) => {
  await page.goto("/admin/products");
  await page
    .locator(".el-table__body-wrapper tbody tr")
    .first()
    .getByRole("button", { name: "编辑", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "编辑商品" });
  const upload = page.getByLabel("上传商品图片", { exact: true });
  await page.evaluate(() => {
    const original = FileReader.prototype.readAsDataURL;
    document.documentElement.dataset.imageReads = "0";
    FileReader.prototype.readAsDataURL = function (blob) {
      document.documentElement.dataset.imageReads = String(
        Number(document.documentElement.dataset.imageReads) + 1,
      );
      original.call(this, blob);
    };
  });
  const file = await png(page);
  await upload.setInputFiles(
    Array.from({ length: 12 }, (_, i) => ({ ...file, name: `image-${i}.png` })),
  );
  await expect(dialog.getByRole("alert")).toContainText("12");
  expect(
    await page.evaluate(() => document.documentElement.dataset.imageReads),
  ).toBe("0");
  const large = await png(page, 2 * 1024 * 1024);
  await upload.setInputFiles([large, large, large]);
  await expect(dialog.getByRole("alert")).toContainText("5 MiB");
  expect(
    await page.evaluate(() => document.documentElement.dataset.imageReads),
  ).toBe("0");
  await expect(dialog.getByAltText("商品图片预览")).toHaveCount(1);
  await upload.setInputFiles(file);
  await expect(dialog.getByAltText("商品图片预览")).toHaveCount(2);
});
async function png(page: Page, size = 0, mimeType = "image/png") {
  const data = await page.evaluate((type) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 2;
    canvas.getContext("2d")!.fillRect(0, 0, 2, 2);
    return canvas.toDataURL(type).split(",")[1]!;
  }, mimeType);
  const original = Buffer.from(data, "base64");
  const bytes = Buffer.alloc(Math.max(size, original.length));
  original.copy(bytes);
  return { name: `valid.${mimeType.split("/")[1]}`, mimeType, buffer: bytes };
}
test.beforeEach(async ({ page }) => {
  test.skip(!!process.env.PLAYWRIGHT_BASE_URL, "目录写入仅使用隔离夹具");
  await page.request.post("/api/auth/login", {
    headers: { "X-ShopMate-Request": "1" },
    data: { role: "admin", username: "admin", password: TEST_ADMIN_PASSWORD },
  });
});
test("图片读取和解码失败保留草稿并能重试，保存失败不丢失元金额", async ({
  page,
}) => {
  await page.goto("/admin/products");
  await page.getByPlaceholder("搜索商品名称").fill("静听 无线头戴耳机");
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "编辑商品" });
  await dialog.getByLabel("商品名称", { exact: true }).fill("保留编辑草稿");
  const upload = page.getByLabel("上传商品图片", { exact: true });
  await upload.setInputFiles({
    name: "broken.png",
    mimeType: "image/png",
    buffer: Buffer.from("not an image"),
  });
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(dialog.getByAltText("商品图片预览")).toHaveCount(1);
  await page.evaluate(() => {
    const original = FileReader.prototype.readAsDataURL;
    let fail = true;
    FileReader.prototype.readAsDataURL = function (blob) {
      if (fail) {
        fail = false;
        queueMicrotask(() => this.dispatchEvent(new Event("error")));
      } else original.call(this, blob);
    };
  });
  const file = await png(page);
  await upload.setInputFiles(file);
  await expect(dialog.getByRole("alert")).toContainText("读取图片失败");
  await expect(dialog.getByLabel("商品名称", { exact: true })).toHaveValue(
    "保留编辑草稿",
  );
  await upload.setInputFiles(file);
  await expect(dialog.getByAltText("商品图片预览")).toHaveCount(2);
  await dialog
    .getByRole("button", { name: "移除商品图片 2", exact: true })
    .click();
  await expect(dialog.getByAltText("商品图片预览")).toHaveCount(1);
  const signatureOnly = Buffer.alloc(80);
  file.buffer.subarray(0, 24).copy(signatureOnly);
  await upload.setInputFiles({ ...file, buffer: signatureOnly });
  await expect(dialog.getByRole("alert")).toContainText("无法解码");
  await expect(dialog.getByAltText("商品图片预览")).toHaveCount(1);
  const price = dialog.getByLabel("售价（元）", { exact: true }).first();
  await price.fill("1.001");
  let writes = 0,
    reject = true;
  await page.route("**/api/actions/saveProduct", async (route) => {
    writes++;
    if (reject)
      await route.fulfill({
        status: 503,
        json: { message: "测试保存失败，可重试" },
      });
    else await route.continue();
  });
  await dialog.getByRole("button", { name: "保存商品", exact: true }).click();
  await expect(
    page.getByText("金额请以元填写，最多两位小数", { exact: true }),
  ).toBeVisible();
  expect(writes).toBe(0);
  await price.fill("0.01");
  await dialog.getByRole("button", { name: "保存商品", exact: true }).click();
  await expect(
    page.getByText("测试保存失败，可重试", { exact: true }),
  ).toBeVisible();
  await expect(price).toHaveValue("0.01");
  await expect(dialog.getByLabel("商品名称", { exact: true })).toHaveValue(
    "保留编辑草稿",
  );
  reject = false;
  await dialog.getByRole("button", { name: "保存商品", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(writes).toBe(2);
});
test("分类创建修改支持三种可解码图片，删除仍保护关联商品", async ({ page }) => {
  await page.goto("/admin/categories");
  await page.getByRole("button", { name: "新建分类", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "新建分类" });
  await dialog.getByLabel("分类名称", { exact: true }).fill("图片分类验收");
  await dialog
    .getByLabel("描述", { exact: true })
    .fill("图片格式和分类保存测试");
  await page
    .getByLabel("上传分类图片", { exact: true })
    .setInputFiles(await png(page));
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  for (const type of ["image/jpeg", "image/webp"]) {
    const row = page
      .locator(".el-table__body-wrapper tbody tr")
      .filter({ hasText: "图片分类验收" });
    await row.getByRole("button", { name: "编辑", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "编辑分类" });
    await dialog
      .getByRole("button", { name: "移除分类图片 1", exact: true })
      .click();
    await page
      .getByLabel("上传分类图片", { exact: true })
      .setInputFiles(await png(page, 0, type));
    await expect(dialog.getByAltText("分类图片预览")).toHaveCount(1);
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await page.reload();
    const db = (await (await page.request.get("/api/state?role=admin")).json())
      .db;
    expect(
      db.categories.find((c: { name: string }) => c.name === "图片分类验收")
        .image,
    ).toMatch(new RegExp(`^data:${type};base64,`));
  }
  const row = page
    .locator(".el-table__body-wrapper tbody tr")
    .filter({ hasText: "图片分类验收" });
  await row.getByRole("button", { name: "删除", exact: true }).click();
  await page.getByRole("button", { name: "确定", exact: true }).click();
  await expect(row).toHaveCount(0);
  const used = page
    .locator(".el-table__body-wrapper tbody tr")
    .filter({ hasText: "数码电器" });
  await used.getByRole("button", { name: "删除", exact: true }).click();
  await page.getByRole("button", { name: "确定", exact: true }).click();
  await expect(
    page.getByText("该分类仍有关联商品，请先调整商品分类", { exact: true }),
  ).toBeVisible();
  await expect(used).toHaveCount(1);
});
test("商品列表数据缩减后校正末页而非显示空表", async ({ page }) => {
  await page.goto("/admin/products");
  await page.locator(".admin-toolbar .el-select").nth(1).click();
  await page.getByRole("option", { name: "已上架", exact: true }).click();
  await page.locator(".el-pager li").filter({ hasText: /^3$/ }).click();
  await expect(page.locator(".el-table__body-wrapper tbody tr")).toHaveCount(3);
  const db = (await (await page.request.get("/api/state?role=admin")).json())
    .db;
  for (const product of db.products
    .filter((p: { active: boolean }) => p.active)
    .slice(0, 3)) {
    const response = await page.request.post("/api/actions/toggleProduct", {
      headers: { "X-ShopMate-Request": "1" },
      data: { args: [product.id] },
    });
    expect(response.ok()).toBe(true);
  }
  await expect(page.locator(".el-pager li.is-active")).toHaveText("2");
  await expect(page.locator(".el-table__body-wrapper tbody tr")).toHaveCount(
    10,
  );
});
test("合法 1.6 MiB 商品图片可保存刷新，售价按元输入且保持整数分", async ({
  page,
}) => {
  await page.goto("/admin/products");
  await page.getByPlaceholder("搜索商品名称").fill("静听 无线头戴耳机");
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "编辑商品" });
  await page
    .getByLabel("上传商品图片", { exact: true })
    .setInputFiles(await png(page, Math.floor(1.6 * 1024 * 1024)));
  await expect(dialog.getByAltText("商品图片预览")).toHaveCount(2);
  const response = page.waitForResponse((r) =>
    r.url().includes("/api/actions/saveProduct"),
  );
  await dialog.getByRole("button", { name: "保存商品", exact: true }).click();
  expect((await response).ok()).toBe(true);
  await expect(dialog).not.toBeVisible();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await dialog.getByLabel("售价（元）", { exact: true }).first().fill("99.90");
  await dialog.getByRole("button", { name: "保存商品", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.reload();
  await page.getByPlaceholder("搜索商品名称").fill("静听 无线头戴耳机");
  await expect(page.locator(".el-table__body-wrapper")).toContainText("¥99.90");
  const db = (await (await page.request.get("/api/state?role=admin")).json())
    .db;
  expect(
    db.products.find((p: { id: string }) => p.id === "p01").skus[0].price,
  ).toBe(9990);
});
