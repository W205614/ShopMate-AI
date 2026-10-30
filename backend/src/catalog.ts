import { checkVersion } from "./versions";
import { reservedStock } from "./commerce-rules";
import type { ShopApi } from "../../shared/domain/api";
import { HttpError } from "./auth";
import {
  transact,
  admin,
  requireThat,
  integer,
  id,
  clone,
  move,
  ledger,
  now,
  productSku,
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
        db.categories.some((c) => c.id === input.categoryId),
        "请选择有效分类",
      );
      const existing = input.id
        ? db.products.find((p) => p.id === input.id)
        : undefined;
      requireThat(!input.id || existing, "商品不存在");
      if (existing) checkVersion(existing, input.version);
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
          name: s.name,
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
      const value = {
        ...clone(input),
        id: productId,
        skus,
        version: (existing?.version ?? (existing ? 1 : 0)) + 1,
      };
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
  async toggleProduct(productId, active, version) {
    await transact((db) => {
      admin();
      const p = db.products.find((p) => p.id === productId);
      requireThat(p, "商品不存在");
      checkVersion(p, version);
      p.active = active ?? !p.active;
      p.version = (p.version ?? 1) + 1;
    });
  },
  async saveCategory(input) {
    await transact((db) => {
      admin();
      requireThat(
        !db.categories.some((c) => c.name === input.name && c.id !== input.id),
        "分类名称已存在",
      );
      const old = input.id
        ? db.categories.find((c) => c.id === input.id)
        : undefined;
      requireThat(!input.id || old, "分类不存在");
      if (old) checkVersion(old, input.version);
      const value = {
        ...input,
        id: old?.id ?? id("cat-"),
        version: (old?.version ?? (old ? 1 : 0)) + 1,
      };
      if (old) Object.assign(old, value);
      else db.categories.push(value);
    });
  },
  async deleteCategory(categoryId, version) {
    await transact((db) => {
      admin();
      const category = db.categories.find((c) => c.id === categoryId);
      requireThat(category, "分类不存在");
      checkVersion(category, version);
      requireThat(
        !db.products.some((p) => p.categoryId === categoryId),
        "该分类仍有关联商品，请先调整商品分类",
      );
      db.categories = db.categories.filter((c) => c.id !== categoryId);
    });
  },
  async adjustStock(productId, skuId, quantity, cost, reason, options) {
    return transact((db) => {
      const adminId = admin().id;
      const mode = options?.mode ?? "delta";
      requireThat(
        mode === "count" ? quantity >= 0 : quantity !== 0,
        "盘点数量不能为负数，库存增减不能为零",
      );
      requireThat(
        mode !== "count" ||
          (integer(options?.expectedStock as number) && cost === 0),
        "盘点必须提交读取时库存，且不能登记采购支出",
      );
      const fingerprint = JSON.stringify({
        productId,
        skuId,
        quantity,
        cost,
        reason: reason.trim(),
        mode,
        expectedStock: options?.expectedStock ?? null,
      });
      const at = now();
      db.inventoryRequests = db.inventoryRequests.filter(
        (r) => Date.parse(r.createdAt) + 86400000 > Date.parse(at),
      );
      const previous =
        options &&
        db.inventoryRequests.find(
          (r) => r.adminId === adminId && r.requestId === options.requestId,
        );
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new HttpError(
            409,
            "请求标识已用于其他库存操作，请核对变动记录",
          );
        return clone(previous.result);
      }
      const { sku } = productSku(db, productId, skuId),
        beforeStock = sku.stock;
      if (
        options?.expectedStock !== undefined &&
        beforeStock !== options.expectedStock
      )
        throw new HttpError(
          409,
          "库存已变化，请加载最新库存，重新核对实盘数量后提交",
        );
      const delta = mode === "count" ? quantity - beforeStock : quantity;
      requireThat(delta > 0 || cost === 0, "库存减少不能记录采购支出");
      requireThat(
        beforeStock + delta >= reservedStock(db, productId, skuId),
        "库存不能低于已预占数量",
      );
      const movement = move(db, productId, skuId, delta, reason.trim());
      Object.assign(movement, { beforeStock, afterStock: sku.stock, mode });
      if (mode === "delta" && delta > 0 && cost > 0)
        Object.assign(ledger(db, "purchase", cost, skuId, reason.trim()), {
          inventoryMovementId: movement.id,
        });
      const result = {
        movementId: movement.id,
        beforeStock,
        afterStock: sku.stock,
        delta,
      };
      if (options)
        db.inventoryRequests.push({
          adminId,
          requestId: options.requestId,
          fingerprint,
          result: clone(result),
          createdAt: at,
        });
      return result;
    });
  },
  async saveSettings(input, baseline) {
    return transact((db) => {
      admin();
      if (
        (["name", "slogan", "notice"] as const).some(
          (key) => db.settings[key] !== baseline[key],
        )
      )
        throw new HttpError(
          409,
          "设置已被其他页面修改，请加载最新设置后重新编辑",
        );
      checkVersion(db.settings, baseline.version);
      db.settings = {
        ...clone(input),
        version: (db.settings.version ?? 1) + 1,
      };
      return { settings: clone(db.settings), revision: db.revision + 1 };
    });
  },
};
