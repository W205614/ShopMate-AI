import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { initialDatabase, openDatabase, readDatabase } from "../src/database";
import { createSeed } from "../../shared/domain/seed";
import { migrateDatabase } from "../src/migration";
import type { Database } from "../../shared/domain/types";

function legacyFile(path: string, db: Database) {
  const sql = new DatabaseSync(path);
  sql.exec(`CREATE TABLE accounts(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE COLLATE NOCASE,name TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('user','admin')),password_hash TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),expires_at INTEGER NOT NULL);
    CREATE TABLE state(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL);`);
  sql.prepare("INSERT INTO state VALUES(1,?)").run(JSON.stringify(db));
  return sql;
}

function legacyState(): Database {
  const db = createSeed();
  db.version = 1;
  for (const field of [
    "coupons",
    "couponClaims",
    "reviews",
    "checkoutQuotes",
    "orderRequests",
    "inventoryRequests",
  ])
    Reflect.deleteProperty(db, field);
  for (const order of db.orders) {
    for (const field of [
      "subtotal",
      "discount",
      "refundedAmount",
      "events",
      "expiresAt",
    ])
      Reflect.deleteProperty(order, field);
    for (const item of order.items)
      for (const field of ["id", "discount", "total", "refundedQuantity"])
        Reflect.deleteProperty(item, field);
  }
  return db;
}

describe("v1 业务状态升级", () => {
  it("v2 仅增量增加库存请求集合，不改旧业务，重启及恢复稳定", () => {
    const directory = mkdtempSync(join(tmpdir(), "shopmate-stock-migration-"));
    const path = join(directory, "v2.sqlite");
    const old = createSeed();
    old.version = 2;
    Reflect.deleteProperty(old, "inventoryRequests");
    old.orders.find((o) => o.status === "pending")!.expiresAt =
      "2026-10-01T00:00:00Z";
    let sql = legacyFile(path, old);
    try {
      sql
        .prepare("INSERT INTO accounts VALUES (?, ?, ?, ?, ?, ?)")
        .run("u1", "lin", "旧用户", "user", "kept-hash", 1000);
      sql
        .prepare("INSERT INTO sessions VALUES (?, ?, ?)")
        .run("kept-token", "u1", Date.now() + 86400000);
      sql.close();
      copyFileSync(path, join(directory, "backup.sqlite"));
      sql = openDatabase(path);
      const migrated = readDatabase(sql);
      const expected = structuredClone(old);
      migrateDatabase(expected);
      expect(migrated).toEqual(expected);
      expect(
        (
          sql.prepare("SELECT data FROM state WHERE id=1").get() as {
            data: string;
          }
        ).data,
      ).toBe(JSON.stringify(old));
      expect(() => sql.prepare("UPDATE state SET data='{}'").run()).toThrow(
        "read-only",
      );
      expect(
        sql.prepare("SELECT password_hash FROM accounts WHERE id='u1'").get(),
      ).toMatchObject({ password_hash: "kept-hash" });
      expect(
        sql
          .prepare(
            "SELECT account_id FROM sessions WHERE token_hash='kept-token'",
          )
          .get(),
      ).toMatchObject({ account_id: "u1" });
      sql.close();
      sql = openDatabase(path);
      expect(readDatabase(sql)).toEqual(migrated);
      const restored = openDatabase(join(directory, "backup.sqlite"));
      try {
        expect(readDatabase(restored)).toEqual(migrated);
      } finally {
        restored.close();
      }
    } finally {
      sql.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("拒绝未来版本状态，避免旧程序覆盖新结构", () => {
    const db = createSeed();
    db.version = 5;
    const before = structuredClone(db);
    expect(() => migrateDatabase(db)).toThrow("版本高于");
    expect(db).toEqual(before);
  });
  it("保留账号、会话、金额、流水和库存，稳定行 ID，重复启动不延长旧待付款期限", () => {
    const directory = mkdtempSync(join(tmpdir(), "shopmate-migration-"));
    const path = join(directory, "old.sqlite");
    const legacy = legacyState();
    let sql = legacyFile(path, legacy);
    try {
      sql
        .prepare("INSERT INTO accounts VALUES (?, ?, ?, ?, ?, ?)")
        .run("u1", "lin", "林小满", "user", "retained-password-hash", 1000);
      sql
        .prepare("INSERT INTO sessions VALUES (?, ?, ?)")
        .run("retained-token-hash", "u1", Date.now() + 86400000);
      sql.close();
      copyFileSync(path, join(directory, "backup.sqlite"));
      const start = Date.now();
      sql = openDatabase(path);
      const migrated = readDatabase(sql);
      expect(migrated.version).toBe(4);
      expect(migrated.orders.map((o) => o.total)).toEqual(
        legacy.orders.map((o) => o.total),
      );
      expect(migrated.inventory).toEqual(legacy.inventory);
      expect(migrated.ledger).toEqual(legacy.ledger);
      expect(migrated.products).toEqual(legacy.products);
      expect(migrated.users).toEqual(legacy.users);
      expect(
        sql.prepare("SELECT password_hash FROM accounts WHERE id='u1'").get(),
      ).toMatchObject({ password_hash: "retained-password-hash" });
      expect(
        sql
          .prepare(
            "SELECT account_id FROM sessions WHERE token_hash='retained-token-hash'",
          )
          .get(),
      ).toMatchObject({ account_id: "u1" });
      const pending = migrated.orders.find((o) => o.status === "pending")!;
      expect(Date.parse(pending.expiresAt!)).toBeGreaterThanOrEqual(
        start + 1800000,
      );
      expect(Date.parse(pending.expiresAt!)).toBeLessThan(start + 1805000);
      expect(
        migrated.orders.every((o) =>
          o.items.every((i) => i.id.startsWith(o.id)),
        ),
      ).toBe(true);
      sql.close();
      sql = openDatabase(path);
      expect(readDatabase(sql)).toEqual(migrated);
      const restored = openDatabase(join(directory, "backup.sqlite"));
      try {
        const backup = readDatabase(restored);
        expect(backup.orders.map((o) => o.total)).toEqual(
          legacy.orders.map((o) => o.total),
        );
        expect(backup.inventory).toEqual(legacy.inventory);
      } finally {
        restored.close();
      }
    } finally {
      sql.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("旧整单售后转换行数量和实付金额，已退款不重复回补或新增流水，不虚构历史时间", () => {
    const legacy = legacyState(),
      order = legacy.orders[0]!;
    order.status = "refunded";
    const oldSale = {
      id: "legacy-refund",
      orderId: order.id,
      userId: order.userId,
      reason: "历史退款",
      description: "旧整单退款",
      status: "refunded",
      requiresReturn: true,
      createdAt: order.createdAt,
      note: "已退款",
    };
    legacy.afterSales.push(oldSale as Database["afterSales"][number]);
    const ledger = structuredClone(legacy.ledger),
      inventory = structuredClone(legacy.inventory);
    expect(migrateDatabase(legacy, "2026-10-17T00:00:00.000Z")).toBe(true);
    expect(legacy.afterSales[0]!.lines).toEqual([
      { orderItemId: order.items[0]!.id, quantity: 1, amount: order.total },
    ]);
    expect(order.refundedAmount).toBe(order.total);
    expect(order.items[0]!.refundedQuantity).toBe(1);
    expect(legacy.ledger).toEqual(ledger);
    expect(legacy.inventory).toEqual(inventory);
    expect(legacy.afterSales[0]!.events).toEqual([
      { at: oldSale.createdAt, actor: "system", action: "requested" },
    ]);
    expect(order.completedAt).toBeUndefined();
    const migrated = structuredClone(legacy);
    expect(migrateDatabase(legacy, "2027-01-01T00:00:00.000Z")).toBe(false);
    expect(legacy).toEqual(migrated);
  });
  it("正常初始数据库不带演示用户、订单、优惠券或评价", () => {
    const db = initialDatabase();
    for (const collection of [
      db.users,
      db.orders,
      db.afterSales,
      db.ledger,
      db.coupons,
      db.couponClaims,
      db.reviews,
      db.checkoutQuotes,
      db.orderRequests,
      db.inventoryRequests,
    ])
      expect(collection).toEqual([]);
    expect(db.products).not.toHaveLength(0);
  });
});
