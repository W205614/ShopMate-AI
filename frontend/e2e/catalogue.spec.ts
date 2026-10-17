import { test, expect } from "./fixtures";

test("首页分类实时切换，列表和分类页保持数量一致", async ({ page }) => {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "首页快捷分类" });
  await expect(page.locator(".sheet-frame")).toHaveCount(23);
  await nav.getByRole("button", { name: "家居生活 4", exact: true }).click();
  await expect(
    nav.getByRole("button", { name: "家居生活 4", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".sheet-frame")).toHaveCount(4);
  await expect(page.locator(".sheet-frame").first()).toContainText(
    "陶瓷马克杯",
  );
  await page.getByRole("link", { name: "查看家居生活" }).click();
  await expect(page).toHaveURL(/category=c2/);
  await expect(page.locator(".catalogue-results .product-card")).toHaveCount(4);
  await page.goto("/categories");
  await expect(page.locator(".category-gallery > a")).toHaveCount(6);
  await page
    .locator(".category-gallery > a")
    .filter({ hasText: "运动户外" })
    .click();
  await expect(page.locator(".catalogue-results .product-card")).toHaveCount(3);
});

test("搜索覆盖分类材质规格和多关键词，顶部搜索可提交", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("textbox", { name: "搜索商品", exact: true })
    .fill("数码 茶轴");
  await page.getByRole("button", { name: "提交搜索" }).click();
  await expect(page.locator(".catalogue-results .product-card")).toHaveCount(1);
  await expect(page.locator(".catalogue-results")).toContainText("机械键盘");
  await page.getByRole("textbox", { name: "搜索商品关键词" }).fill("通勤 耳机");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await expect(page.locator(".catalogue-results .product-card")).toHaveCount(1);
  await expect(page.locator(".catalogue-results")).toContainText("头戴耳机");
});

test("价格独立应用、校验小数与倒置范围，筛选可单独移除", async ({ page }) => {
  await page.goto("/products?category=c1&sort=price-asc");
  await page
    .getByRole("textbox", { name: "搜索商品关键词" })
    .fill("未提交关键词");
  await page.getByLabel("最低价格").fill("169.00");
  await page.getByLabel("最高价格").fill("289.00");
  await page.getByRole("button", { name: "应用价格" }).click();
  await expect(page.locator(".catalogue-results .product-card")).toHaveCount(3);
  expect(new URL(page.url()).searchParams.has("q")).toBe(false);
  await expect(
    page.locator(".catalogue-results .product-card").first(),
  ).toContainText("阅读灯");
  await page.getByLabel("最低价格").fill("300");
  await page.getByRole("button", { name: "应用价格" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "最低价格不能高于最高价格",
  );
  await page.getByLabel("最低价格").fill("0.001");
  await page.getByRole("button", { name: "应用价格" }).click();
  await expect(page.getByRole("alert")).toContainText("最多保留两位小数");
  await page.getByRole("button", { name: "移除最高 ¥289.00" }).click();
  await expect(page.locator(".catalogue-results .product-card")).toHaveCount(4);
  expect(new URL(page.url()).searchParams.get("sort")).toBe("price-asc");
});

test("搜索不提交价格草稿，有货筛选、刷新与前进后退保留状态", async ({
  page,
}) => {
  await page.goto("/products?category=c6");
  await page.getByLabel("最低价格").fill("999");
  await page.getByRole("textbox", { name: "搜索商品关键词" }).fill("运动");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  expect(new URL(page.url()).searchParams.has("min")).toBe(false);
  await expect(page.locator(".catalogue-results .product-card")).toHaveCount(3);
  await page.getByLabel("仅看有货", { exact: true }).check();
  await expect(page.locator(".catalogue-results .product-card")).toHaveCount(2);
  await page.reload();
  await expect(page.getByLabel("仅看有货", { exact: true })).toBeChecked();
  await expect(
    page.getByRole("textbox", { name: "搜索商品关键词" }),
  ).toHaveValue("运动");
  await page.getByRole("button", { name: "移除仅看有货" }).click();
  await expect(page.locator(".catalogue-results .product-card")).toHaveCount(3);
  await page.goBack();
  await expect(page.getByLabel("仅看有货", { exact: true })).toBeChecked();
  await page.goForward();
  await expect(page.getByLabel("仅看有货", { exact: true })).not.toBeChecked();
});

test("分页边界、筛选后回首页、异常URL和空结果恢复", async ({ page }) => {
  await page.goto("/products?page=999&sort=price-asc");
  await expect(page.locator(".catalogue-results .product-card")).toHaveCount(
    11,
  );
  await expect(
    page.getByRole("navigation", { name: "商品分页" }),
  ).toContainText("2 / 2");
  await expect(page.getByRole("button", { name: "下一页" })).toBeDisabled();
  await page.getByRole("button", { name: "上一页" }).click();
  await expect(page.locator(".catalogue-results .product-card")).toHaveCount(
    12,
  );
  await page.getByRole("button", { name: "下一页" }).click();
  await page.getByRole("button", { name: "家居生活 4", exact: true }).click();
  await expect(page.locator(".catalogue-results .product-card")).toHaveCount(4);
  expect(new URL(page.url()).searchParams.has("page")).toBe(false);
  await page.goto("/products?page=Infinity&min=NaN&sort=invalid&q=数码&q=耳机");
  await expect(page.locator(".catalogue-results .product-card")).toHaveCount(4);
  await expect(page.getByLabel("排序")).toHaveValue("featured");
  await page.goto("/products?category=deleted");
  await expect(
    page.getByRole("heading", { name: "已失效分类", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "移除已失效分类" }).click();
  await expect(page.locator(".catalogue-results .product-card")).toHaveCount(
    12,
  );
  await page.goto("/products?min=100&max=10");
  await expect(page.locator(".empty-state")).toContainText(
    "最低价格不能高于最高价格",
  );
  await page.getByRole("link", { name: "查看全部商品", exact: true }).click();
  await expect(page.locator(".catalogue-results .product-card")).toHaveCount(
    12,
  );
});

test("手机分类、组合筛选和空结果页面没有横向溢出", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "首页快捷分类" })
    .getByRole("button", { name: "运动户外 3", exact: true })
    .click();
  await expect(page.locator(".sheet-frame")).toHaveCount(3);
  for (const path of [
    "/",
    "/categories",
    "/products?category=c2&min=0.01&max=100.50&stock=1",
    "/products?q=" + "不存在".repeat(25),
  ]) {
    await page.goto(path);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  }
});
