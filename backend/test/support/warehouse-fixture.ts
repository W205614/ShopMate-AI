import { createSeed } from "../../../shared/domain/seed";
import { defaultWarehouseId } from "../../../shared/domain/warehouses";
import type { Database } from "../../../shared/domain/types";
import { migrateDatabase } from "../../src/migration";
import { productSku } from "../../src/repository";
import { stockRow } from "../../src/warehouse-stock";

export function currentSeed() {
  const db = createSeed();
  migrateDatabase(db);
  return db;
}

export function setStock(
  db: Database,
  productId: string,
  skuId: string,
  quantity: number,
) {
  productSku(db, productId, skuId).sku.stock = quantity;
  stockRow(db, defaultWarehouseId, productId, skuId).onHand = quantity;
}
