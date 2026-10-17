import { describe, expect, it } from "vitest";
import { createSeed } from "../../../shared/domain/seed";
import {
  catalogueCategories,
  productPrice,
  readCatalogueQuery,
  searchProducts,
} from "./catalogue";

const db = createSeed();
const find = (query: Parameters<typeof readCatalogueQuery>[0]) =>
  searchProducts(db.products, db.categories, readCatalogueQuery(query));

describe("public catalogue", () => {
  it("matches all words across category, material and SKU, case and full-width text", () => {
    expect(find({ q: "数码 茶轴" }).map((p) => p.id)).toEqual(["p02"]);
    expect(find({ q: "ＰＢＴ" }).map((p) => p.id)).toEqual(["p02"]);
    expect(find({ q: "通勤，耳机" }).map((p) => p.id)).toEqual(["p01"]);
    expect(find({ q: "耳机 陶瓷" })).toEqual([]);
    expect(find({ q: "，、 " })).toHaveLength(23);
  });
  it("combines category, inclusive cent prices and available stock without mutating data", () => {
    const prices = find({
      category: "c1",
      min: "169.00",
      max: "289.00",
      sort: "price-asc",
    }).map(productPrice);
    expect(prices).toEqual([16900, 22900, 28900]);
    expect(
      find({ stock: "1" }).every((p) => p.skus.some((s) => s.stock > 0)),
    ).toBe(true);
    expect(find({}).some((p) => p.id === "p22")).toBe(true);
    expect(find({ stock: "1" }).some((p) => p.id === "p22")).toBe(false);
    expect(find({}).some((p) => p.id === "p24")).toBe(false);
    expect(db.products[0]?.id).toBe("p01");
    const descending = find({ sort: "price-desc" }).map(productPrice);
    expect(descending).toEqual([...descending].sort((a, b) => b - a));
  });
  it("uses displayed minimum SKU price even when that SKU is sold out", () => {
    const p = structuredClone(db.products[0]!);
    p.skus = [
      { id: "cheap", name: "a", price: 1990, stock: 0 },
      { id: "available", name: "b", price: 3990, stock: 1 },
    ];
    expect(
      searchProducts(
        [p],
        db.categories,
        readCatalogueQuery({ max: "19.90", stock: "1" }),
      ),
    ).toHaveLength(1);
  });
  it("handles invalid, repeated and reversed URL parameters safely", () => {
    for (const page of ["NaN", "Infinity", "-1", "1.5", "9007199254740992"])
      expect(readCatalogueQuery({ page }).page).toBe(1);
    for (const min of [
      "NaN",
      "Infinity",
      "-1",
      "0.001",
      "1e5",
      "9007199254740992",
    ])
      expect(readCatalogueQuery({ min }).min).toBeUndefined();
    expect(
      readCatalogueQuery({ q: ["耳机", "键盘"], sort: "unknown" }),
    ).toMatchObject({ q: "耳机", sort: "featured" });
    expect(find({ min: "100", max: "10" })).toEqual([]);
    expect(find({ category: "removed" })).toEqual([]);
    expect(find({ min: "0", max: "0" })).toEqual([]);
  });
  it("counts only active products and follows configured category ordering", () => {
    const categories = structuredClone(db.categories).reverse();
    categories[0]!.sort = -1;
    const summary = catalogueCategories(categories, db.products);
    expect(summary[0]?.id).toBe(categories[0]?.id);
    expect(summary.reduce((n, c) => n + c.count, 0)).toBe(23);
    expect(summary.find((c) => c.id === "c6")?.count).toBe(3);
    expect(categories[0]?.sort).toBe(-1);
  });
});
