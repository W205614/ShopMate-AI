// Shared demo persistence, serialized transactions, and domain helpers.
import type { Database, Message, Order, Role, Session } from "../domain/types";
import { createSeed } from "../domain/seed";

export const STORAGE_KEY = "shopmate-ai:database:v1";
export const SESSION_KEY = "shopmate-ai:session:";
const listeners = new Set<(db: Database) => void>();
export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
export const id = (prefix: string) =>
  prefix + crypto.randomUUID().replaceAll("-", "").slice(0, 12);
export const now = () => new Date().toISOString();
export function requireThat(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new Error(message);
}
export const integer = (n: number, min = 0) =>
  Number.isSafeInteger(n) && n >= min;
export const text = (s: string, max = 500) =>
  s.trim().length > 0 && s.trim().length <= max;
let storageIssue = "";
export const getStorageIssue = () => storageIssue;

function validDatabase(db: Database): boolean {
  try {
    const string = (value: unknown): value is string =>
      typeof value === "string";
    const unique = (items: { id: string }[]) =>
      items.every((i) => i && string(i.id)) &&
      new Set(items.map((i) => i.id)).size === items.length;
    const address = (a: Database["addresses"][number]) =>
      a &&
      [a.id, a.userId, a.name, a.phone, a.region, a.detail].every(string) &&
      typeof a.isDefault === "boolean";
    const message = (m: Message) =>
      m &&
      [m.id, m.text, m.createdAt].every(string) &&
      ["user", "assistant", "agent"].includes(m.role) &&
      (!m.productIds ||
        (Array.isArray(m.productIds) && m.productIds.every(string)));
    return (
      [
        db.products,
        db.categories,
        db.users,
        db.orders,
        db.carts,
        db.addresses,
        db.afterSales,
        db.inventory,
        db.ledger,
        db.conversations,
        db.faqs,
      ].every(unique) &&
      db.users.every((u) => [u.username, u.name].every(string)) &&
      db.categories.every(
        (c) =>
          [c.name, c.description, c.image].every(string) && integer(c.sort),
      ) &&
      db.products.every(
        (p) =>
          [p.name, p.subtitle, p.description, p.material, p.categoryId].every(
            string,
          ) &&
          db.categories.some((c) => c.id === p.categoryId) &&
          typeof p.active === "boolean" &&
          typeof p.featured === "boolean" &&
          Array.isArray(p.images) &&
          p.images.length > 0 &&
          p.images.every(string) &&
          Array.isArray(p.skus) &&
          p.skus.length > 0 &&
          unique(p.skus) &&
          p.skus.every(
            (s) => string(s.name) && integer(s.price, 1) && integer(s.stock),
          ),
      ) &&
      db.carts.every(
        (c) =>
          [c.userId, c.productId, c.skuId].every(string) &&
          integer(c.quantity, 1) &&
          typeof c.selected === "boolean",
      ) &&
      db.addresses.every(address) &&
      Object.values(db.favorites).every(
        (f) => Array.isArray(f) && f.every(string),
      ) &&
      db.orders.every(
        (o) =>
          string(o.userId) &&
          string(o.createdAt) &&
          integer(o.total, 1) &&
          [
            "pending",
            "paid",
            "shipped",
            "completed",
            "cancelled",
            "refunded",
          ].includes(o.status) &&
          address(o.address) &&
          Array.isArray(o.items) &&
          o.items.length > 0 &&
          o.items.every(
            (i) =>
              i &&
              [i.productId, i.skuId, i.name, i.skuName, i.image].every(
                string,
              ) &&
              integer(i.price, 1) &&
              integer(i.quantity, 1),
          ) &&
          o.total === o.items.reduce((n, i) => n + i.price * i.quantity, 0),
      ) &&
      db.inventory.every(
        (m) =>
          [m.productId, m.skuId, m.reason, m.createdAt].every(string) &&
          Number.isSafeInteger(m.delta),
      ) &&
      db.ledger.every(
        (l) =>
          [l.reference, l.note, l.createdAt].every(string) &&
          ["payment", "refund", "purchase"].includes(l.type) &&
          integer(l.amount),
      ) &&
      db.afterSales.every(
        (a) =>
          [
            a.orderId,
            a.userId,
            a.reason,
            a.description,
            a.createdAt,
            a.note,
          ].every(string) &&
          typeof a.requiresReturn === "boolean" &&
          [
            "requested",
            "approved",
            "received",
            "refunded",
            "rejected",
          ].includes(a.status),
      ) &&
      db.conversations.every(
        (c) =>
          [c.userId, c.title, c.createdAt].every(string) &&
          ["bot", "waiting", "human", "closed"].includes(c.status) &&
          Array.isArray(c.messages) &&
          c.messages.every(message),
      ) &&
      db.faqs.every(
        (f) =>
          [f.question, f.answer].every(string) &&
          Array.isArray(f.keywords) &&
          f.keywords.every(string) &&
          typeof f.active === "boolean",
      ) &&
      [db.settings.name, db.settings.slogan, db.settings.notice].every(string)
    );
  } catch {
    return false;
  }
}

function read(): Database {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    const initial = createSeed();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(initial));
    return initial;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    requireThat(
      parsed &&
        typeof parsed === "object" &&
        "version" in parsed &&
        parsed.version === 1,
      "演示数据版本不兼容，请在管理端恢复初始数据",
    );
    const db = parsed as Database;
    for (const key of [
      "products",
      "categories",
      "orders",
      "users",
      "addresses",
      "carts",
      "ledger",
      "inventory",
      "afterSales",
      "conversations",
      "faqs",
    ] as const)
      requireThat(
        Array.isArray(db[key]),
        "演示数据损坏，请在管理端恢复初始数据",
      );
    requireThat(
      db.settings && db.favorites && integer(db.revision),
      "演示数据损坏，请在管理端恢复初始数据",
    );
    requireThat(validDatabase(db), "演示数据损坏，请在管理端恢复初始数据");
    return db;
  } catch (error) {
    throw new Error(
      error instanceof Error && error.message.startsWith("演示")
        ? error.message
        : "演示数据损坏，请在管理端恢复初始数据",
      { cause: error },
    );
  }
}

// A recoverable initial state keeps the reset page reachable without overwriting damaged data.
export function getDatabase(): Database {
  try {
    const db = clone(read());
    storageIssue = "";
    return db;
  } catch (error) {
    storageIssue = error instanceof Error ? error.message : "演示数据损坏";
    return createSeed();
  }
}
export function subscribeDatabase(
  listener: (db: Database) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function notify(db: Database) {
  for (const listener of listeners) listener(clone(db));
}
if (typeof window !== "undefined")
  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY || event.key === null) notify(getDatabase());
  });
export function getSession(role: Role): Session | null {
  try {
    const session = JSON.parse(
      sessionStorage.getItem(SESSION_KEY + role) ?? "null",
    ) as Session | null;
    return session?.role === role && typeof session.id === "string"
      ? session
      : null;
  } catch {
    return null;
  }
}
export function userId(): string {
  const session = getSession("user");
  requireThat(session, "请先登录用户账号");
  return session.id;
}
export function admin(): void {
  requireThat(getSession("admin"), "请先登录管理账号");
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
  db.inventory.unshift({
    id: id("stock-"),
    productId,
    skuId,
    delta,
    reason,
    createdAt: now(),
  });
}
export function ledger(
  db: Database,
  type: "payment" | "refund" | "purchase",
  amount: number,
  reference: string,
  note: string,
) {
  requireThat(integer(amount), "金额必须是非负整数分");
  db.ledger.unshift({
    id: id("ledger-"),
    type,
    amount,
    reference,
    note,
    createdAt: now(),
  });
}
let queue: Promise<unknown> = Promise.resolve();
export async function transact<T>(
  change: (db: Database) => T,
  reset = false,
): Promise<T> {
  const run = () => {
    const db = reset ? createSeed() : read();
    const result = change(db);
    db.revision++;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
    } catch {
      throw new Error("无法保存演示数据，请检查浏览器存储空间与隐私设置");
    }
    storageIssue = "";
    notify(db);
    return result;
  };
  // Web Locks serialize read/check/write across same-origin tabs. The local queue is a fallback.
  const operation = () =>
    typeof navigator !== "undefined" && navigator.locks
      ? navigator.locks.request(STORAGE_KEY, run)
      : Promise.resolve().then(run);
  const result = queue.then(operation, operation);
  queue = result.catch(() => undefined);
  return result;
}
