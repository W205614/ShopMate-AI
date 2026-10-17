import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";
import type { Database, Order, Session } from "../../shared/domain/types";
import {
  readDatabase,
  writeDatabase,
  transaction,
  initialDatabase,
} from "./database";
import { HttpError } from "./auth";

export const context = new AsyncLocalStorage<{
  sql: DatabaseSync;
  user: Session | null;
  admin: Session | null;
}>();
export const clone = <T>(value: T): T => structuredClone(value);
export const id = (prefix: string) =>
  prefix + crypto.randomUUID().replaceAll("-", "");
export const now = () => new Date().toISOString();
export function requireThat(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new HttpError(400, message);
}
export const integer = (n: number, min = 0) =>
  Number.isSafeInteger(n) && n >= min;
export const text = (s: string, max = 500) =>
  typeof s === "string" && s.trim().length > 0 && s.trim().length <= max;
export function userId() {
  const session = context.getStore()?.user;
  if (!session) throw new HttpError(401, "请先登录用户账号");
  return session.id;
}
export function admin() {
  const session = context.getStore()?.admin;
  if (!session) throw new HttpError(401, "请先登录管理账号");
  return session;
}
export function getDatabase() {
  return readDatabase(context.getStore()!.sql);
}
export async function transact<T>(
  change: (db: Database) => T,
  reset = false,
): Promise<T> {
  const sql = context.getStore()!.sql;
  return transaction(sql, () => {
    const previous = readDatabase(sql);
    const db = reset ? initialDatabase() : previous;
    if (reset) {
      // Business reset never deletes registered accounts or their valid sessions.
      db.users = previous.users;
      db.revision = previous.revision;
    }
    const result = change(db);
    db.revision++;
    writeDatabase(sql, db);
    return result;
  });
}
export function ownedOrder(db: Database, orderId: string): Order {
  const order = db.orders.find(
    (o) => o.id === orderId && o.userId === userId(),
  );
  requireThat(order, "订单不存在或不属于当前用户");
  return order;
}
export function productSku(db: Database, productId: string, skuId: string) {
  const product = db.products.find((p) => p.id === productId);
  const sku = product?.skus.find((s) => s.id === skuId);
  requireThat(product && sku, "商品或规格不存在");
  return { product, sku };
}
export function move(
  db: Database,
  productId: string,
  skuId: string,
  delta: number,
  reason: string,
) {
  const { sku } = productSku(db, productId, skuId);
  requireThat(integer(sku.stock + delta), "库存不足或库存数量无效");
  sku.stock += delta;
  const movement = {
    id: id("stock-"),
    productId,
    skuId,
    delta,
    reason,
    createdAt: now(),
  };
  db.inventory.unshift(movement);
  return movement;
}
export function ledger(
  db: Database,
  type: "payment" | "refund" | "purchase",
  amount: number,
  reference: string,
  note: string,
) {
  requireThat(integer(amount), "金额必须是非负整数分");
  const entry = {
    id: id("ledger-"),
    type,
    amount,
    reference,
    note,
    createdAt: now(),
  };
  db.ledger.unshift(entry);
  return entry;
}
