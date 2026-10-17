import { test, expect } from "./fixtures";
import type { Database } from "../../shared/domain/types";

test("部署后的公开目录可浏览筛选且不修改业务数据", async ({
  page,
  request,
}, testInfo) => {
  const response = await request.get("/api/state?role=user");
  expect(response.ok()).toBe(true);
  const { db } = (await response.json()) as { db: Database };
  const active = db.products.filter((p) => p.active);
  const category = [...db.categories]
    .sort((a, b) => a.sort - b.sort)
    .find((c) => active.some((p) => p.categoryId === c.id));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.locator(".sheet-frame")).toHaveCount(active.length);
  if (category) {
    const expected = active.filter((p) => p.categoryId === category.id);
    const button = page
      .getByRole("navigation", { name: "首页快捷分类" })
      .getByRole("button", {
        name: `${category.name} ${expected.length}`,
        exact: true,
      });
    await button.click();
    await expect(page.locator(".sheet-frame")).toHaveCount(expected.length);
    await page
      .getByRole("link", { name: `查看${category.name}`, exact: true })
      .click();
    await expect(page.locator(".catalogue-results .product-card")).toHaveCount(
      Math.min(12, expected.length),
    );
    await page.getByLabel("仅看有货", { exact: true }).check();
    await expect(page.locator(".catalogue-results .product-card")).toHaveCount(
      Math.min(
        12,
        expected.filter((p) => p.skus.some((s) => s.stock > 0)).length,
      ),
    );
    await page.reload();
    await expect(page.getByLabel("仅看有货", { exact: true })).toBeChecked();
  }
  const product = active[0];
  if (product) {
    await page.goto("/products?q=" + encodeURIComponent(product.name));
    await expect(page.locator(".catalogue-results")).toContainText(
      product.name,
    );
  }
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    for (const [name, path] of [
      ["home", "/"],
      ["categories", "/categories"],
      ["search", "/products?min=0.01&stock=1&sort=price-asc"],
    ]) {
      await page.goto(path!);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath(`${name}-${width}.png`),
        fullPage: true,
      });
    }
  }
  const after = (await (await request.get("/api/state?role=user")).json()) as {
    db: Database;
  };
  expect(after.db.revision).toBe(db.revision);
  expect(errors).toEqual([]);
});
