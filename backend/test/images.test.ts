import { beforeEach, expect, it } from "vitest";
import { createSeed } from "../../shared/domain/seed";
import {
  validateImages,
  IMAGE_MAX_BYTES,
  IMAGES_MAX_BYTES,
} from "../../shared/domain/images";
import { catalogApi } from "../src/catalog";
import { context } from "../src/repository";
import { openDatabase, readDatabase, writeDatabase } from "../src/database";
import { methods } from "../src/validation";
import { statSync } from "node:fs";
const sql = openDatabase(":memory:");
const png = (size: number) => {
  const bytes = Buffer.alloc(size);
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ).copy(bytes);
  return `data:image/png;base64,${bytes.toString("base64")}`;
};
const admin = <T>(fn: () => T) =>
  context.run(
    { sql, user: null, admin: { id: "admin", name: "admin", role: "admin" } },
    fn,
  );
beforeEach(() => writeDatabase(sql, createSeed()));
it("accepts exact byte/count boundaries and rejects excess without using base64 character limits", () => {
  const max = png(IMAGE_MAX_BYTES);
  expect(
    validateImages([max, max, png(IMAGES_MAX_BYTES - 2 * IMAGE_MAX_BYTES)]),
  ).toBe(IMAGES_MAX_BYTES);
  expect(
    validateImages(Array.from({ length: 12 }, () => "/images/p01.jpg")),
  ).toBe(12 * 86148);
  const product = { ...readDatabase(sql).products[0]!, images: [max] };
  expect(methods.saveProduct.args.safeParse([product]).success).toBe(true);
  expect(() => validateImages([png(IMAGE_MAX_BYTES + 1)])).toThrow("2 MiB");
  expect(() => validateImages([max, max, png(1024 * 1024 + 1)])).toThrow(
    "5 MiB",
  );
  expect(() =>
    validateImages(Array.from({ length: 13 }, () => "/images/p01.jpg")),
  ).toThrow("12");
});
it("keeps the built-in allowlist and byte sizes aligned with shipped assets", () => {
  for (let i = 1; i <= 24; i++) {
    const path = `/images/p${String(i).padStart(2, "0")}.jpg`;
    expect(validateImages([path])).toBe(
      statSync(`../frontend/public${path}`).size,
    );
  }
});
it("rejects remote/unknown local sources, malformed encodings and mismatched file signatures", () => {
  for (const image of [
    "https://example.com/x.jpg",
    "//example.com/x.jpg",
    "/images/../p01.jpg",
    "/images/credits.json",
    "/images/missing.jpg",
    "data:image/svg+xml;base64,PHN2Zz4=",
    "data:image/png;base64,!!!!",
    "data:image/png;base64,aGVsbG8=",
    png(80).replace("image/png", "image/jpeg"),
  ]) {
    expect(() => validateImages([image]), image).toThrow();
  }
});
it("validates product and category images inside the transaction, preserving drafts' persisted data on rejection", async () => {
  const before = readDatabase(sql),
    product = before.products[0]!;
  await expect(
    admin(() =>
      catalogApi.saveProduct({
        ...product,
        images: ["data:image/png;base64,aGVsbG8="],
      }),
    ),
  ).rejects.toThrow();
  expect(readDatabase(sql)).toEqual(before);
  await expect(
    admin(() =>
      catalogApi.saveCategory({
        name: "无效图",
        description: "测试无效分类图片",
        sort: 1,
        image: "https://example.com/x.jpg",
      }),
    ),
  ).rejects.toThrow();
  expect(readDatabase(sql)).toEqual(before);
  await admin(() =>
    catalogApi.saveCategory({
      name: "新分类",
      description: "分类创建与编辑测试",
      sort: 7,
      image: png(80),
    }),
  );
  const category = readDatabase(sql).categories.find(
    (c) => c.name === "新分类",
  )!;
  await admin(() =>
    catalogApi.saveCategory({ ...category, name: "已修改分类" }),
  );
  expect(
    readDatabase(sql).categories.find((c) => c.id === category.id)?.name,
  ).toBe("已修改分类");
  await admin(() => catalogApi.deleteCategory(category.id));
  await expect(admin(() => catalogApi.deleteCategory("c1"))).rejects.toThrow(
    "关联商品",
  );
});
