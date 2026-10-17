import type { ShopApi } from "../../shared/domain/api";
import { validateImages } from "../../shared/domain/images";
import { HttpError } from "./auth";
import {
  transact,
  admin,
  requireThat,
  text,
  integer,
  id,
  clone,
  move,
  ledger,
  now,
} from "./repository";

export const catalogApi: Pick<
  ShopApi,
  | "saveProduct"
  | "toggleProduct"
  | "saveCategory"
  | "deleteCategory"
  | "adjustStock"
  | "saveSettings"
> = {
  async saveProduct(input) {
    await transact((db) => {
      admin();
      requireThat(
        text(input.name, 80) &&
          text(input.subtitle, 120) &&
          text(input.description, 3000) &&
          text(input.material, 300),
        "请完整填写商品名称、副标题、说明与材质",
      );
      requireThat(
        db.categories.some((c) => c.id === input.categoryId),
        "请选择有效分类",
      );
      try {
        validateImages(input.images);
      } catch (error) {
        throw new HttpError(400, (error as Error).message);
      }
      requireThat(
        input.skus.length > 0 &&
          input.skus.every(
            (s) => text(s.name, 100) && integer(s.price, 1) && integer(s.stock),
          ),
        "SKU 名称、价格或库存无效",
      );
      const existing = input.id
        ? db.products.find((p) => p.id === input.id)
        : undefined;
      requireThat(!input.id || existing, "商品不存在");
      const productId = existing?.id ?? id("p-");
      const existingSkuIds = new Set(existing?.skus.map((s) => s.id) ?? []);
      const usedIds = new Set<string>();
      const skus = input.skus.map((s) => {
        const old = existing?.skus.find((old) => old.id === s.id);
        const skuId = old?.id ?? id("sku-");
        requireThat(!usedIds.has(skuId), "规格不能重复");
        usedIds.add(skuId);
        requireThat(
          !old || old.stock === s.stock,
          "已有规格库存请通过库存管理调整，以保留变动记录",
        );
        return {
          id: skuId,
          name: s.name.trim(),
          price: s.price,
          stock: s.stock,
        };
      });
      // Preserve historical SKU references used by orders, carts and inventory records.
      requireThat(
        !existing ||
          existing.skus.every((s) => skus.some((n) => n.id === s.id)),
        "已有规格请保留，可调整名称和价格；库存通过库存管理处理",
      );
      const value = { ...clone(input), id: productId, skus };
      if (existing) Object.assign(existing, value);
      else db.products.unshift(value);
      for (const sku of skus)
        if (!existingSkuIds.has(sku.id)) {
          if (sku.stock)
            db.inventory.unshift({
              id: id("stock-"),
              productId,
              skuId: sku.id,
              delta: sku.stock,
              reason: "商品规格初始库存",
              createdAt: now(),
            });
        }
    });
  },
  async toggleProduct(productId) {
    await transact((db) => {
      admin();
      const p = db.products.find((p) => p.id === productId);
      requireThat(p, "商品不存在");
      p.active = !p.active;
    });
  },
  async saveCategory(input) {
    await transact((db) => {
      admin();
      try {
        validateImages([input.image], 1);
      } catch (error) {
        throw new HttpError(400, (error as Error).message);
      }
      requireThat(
        text(input.name, 30) &&
          text(input.description, 200) &&
          integer(input.sort),
        "请完整填写分类信息，排序必须为非负整数",
      );
      requireThat(
        !db.categories.some(
          (c) => c.name === input.name.trim() && c.id !== input.id,
        ),
        "分类名称已存在",
      );
      const old = input.id
        ? db.categories.find((c) => c.id === input.id)
        : undefined;
      requireThat(!input.id || old, "分类不存在");
      const value = {
        ...input,
        name: input.name.trim(),
        id: old?.id ?? id("cat-"),
      };
      if (old) Object.assign(old, value);
      else db.categories.push(value);
    });
  },
  async deleteCategory(categoryId) {
    await transact((db) => {
      admin();
      requireThat(
        !db.products.some((p) => p.categoryId === categoryId),
        "该分类仍有关联商品，请先调整商品分类",
      );
      db.categories = db.categories.filter((c) => c.id !== categoryId);
    });
  },
  async adjustStock(productId, skuId, delta, cost, reason) {
    await transact((db) => {
      admin();
      requireThat(
        Number.isSafeInteger(delta) &&
          delta !== 0 &&
          integer(cost) &&
          text(reason, 200),
        "请填写非零整数变动数量、有效采购金额及原因",
      );
      requireThat(delta > 0 || cost === 0, "库存减少不能记录采购支出");
      move(db, productId, skuId, delta, reason.trim());
      if (delta > 0 && cost > 0)
        ledger(db, "purchase", cost, skuId, reason.trim());
    });
  },
  async saveSettings(input, baseline) {
    return transact((db) => {
      admin();
      requireThat(
        text(input.name, 40) &&
          text(input.slogan, 80) &&
          typeof input.notice === "string" &&
          input.notice.length <= 200,
        "商城名称和标语不能为空，公告最多 200 字",
      );
      if (
        (["name", "slogan", "notice"] as const).some(
          (key) => db.settings[key] !== baseline[key],
        )
      )
        throw new HttpError(
          409,
          "设置已被其他页面修改，请加载最新设置后重新编辑",
        );
      db.settings = clone(input);
      return { settings: clone(db.settings), revision: db.revision + 1 };
    });
  },
};
