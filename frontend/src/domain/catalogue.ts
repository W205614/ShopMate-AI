import type { LocationQuery } from "vue-router";
import type { Category, Product } from "./types";

export const PAGE_SIZE = 12;
export const queryText = (value: LocationQuery[string]) =>
  (Array.isArray(value) ? value[0] : value) ?? "";

function priceInCents(value: string) {
  if (!/^\d+(\.\d{1,2})?$/.test(value)) return undefined;
  const cents = Math.round(Number(value) * 100);
  return Number.isSafeInteger(cents) ? cents : undefined;
}

export function readCatalogueQuery(query: LocationQuery) {
  const min = priceInCents(queryText(query.min));
  const max = priceInCents(queryText(query.max));
  const page = Number(queryText(query.page));
  return {
    q: queryText(query.q).trim(),
    category: queryText(query.category),
    min,
    max,
    invalidRange: min !== undefined && max !== undefined && min > max,
    inStock: queryText(query.stock) === "1",
    sort: ["price-asc", "price-desc"].includes(queryText(query.sort))
      ? queryText(query.sort)
      : "featured",
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
  };
}

export const productPrice = (product: Product) =>
  Math.min(...product.skus.map((sku) => sku.price));

export function catalogueCategories(
  categories: Category[],
  products: Product[],
) {
  return [...categories]
    .sort((a, b) => a.sort - b.sort || a.id.localeCompare(b.id))
    .map((category) => ({
      ...category,
      count:
        (category as Category & { productCount?: number }).productCount ??
        products.filter((p) => p.active && p.categoryId === category.id).length,
    }));
}

export function searchProducts(
  products: Product[],
  categories: Category[],
  query: ReturnType<typeof readCatalogueQuery>,
) {
  const words = query.q
    .normalize("NFKC")
    .toLowerCase()
    .split(/[\s，、,]+/)
    .filter(Boolean);
  const categoryNames = new Map(categories.map((c) => [c.id, c.name]));
  return products
    .filter((p) => {
      if (!p.active || query.invalidRange) return false;
      if (query.category && p.categoryId !== query.category) return false;
      if (query.inStock && !p.skus.some((sku) => sku.stock > 0)) return false;
      const price = productPrice(p);
      if (query.min !== undefined && price < query.min) return false;
      if (query.max !== undefined && price > query.max) return false;
      const text = [
        p.name,
        p.subtitle,
        p.description,
        p.material,
        categoryNames.get(p.categoryId) ?? "",
        ...p.skus.map((s) => s.name),
      ]
        .join(" ")
        .normalize("NFKC")
        .toLowerCase();
      return words.every((word) => text.includes(word));
    })
    .sort((a, b) => {
      if (query.sort === "price-asc") return productPrice(a) - productPrice(b);
      if (query.sort === "price-desc") return productPrice(b) - productPrice(a);
      return Number(b.featured) - Number(a.featured);
    });
}
