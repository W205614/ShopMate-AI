import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Database } from "../../shared/domain/types";
import { createSeed } from "../../shared/domain/seed";
import { migrateDatabase } from "./migration";
import {
  createStorageSchema,
  loadStoredDatabase,
  saveStoredDatabase,
  preserveBeforeClose,
  type DatabaseReadScope,
} from "./storage";
export { queryPage, queryRecord, tableFor, readMetadata } from "./storage";

// Keep the existing catalog; historical demo people and orders are not real accounts.
export function initialDatabase(): Database {
  const db = createSeed();
  db.users = [];
  db.addresses = [];
  db.carts = [];
  db.orders = [];
  db.afterSales = [];
  db.conversations = [];
  db.favorites = {};
  db.ledger = [];
  db.inventory = db.products.flatMap((p) =>
    p.skus.map((s) => ({
      id: `initial-${s.id}`,
      productId: p.id,
      skuId: s.id,
      delta: s.stock,
      reason: "商品初始库存",
      createdAt: new Date().toISOString(),
    })),
  );
  return db;
}

export function openDatabase(path: string) {
  if (path !== ":memory:")
    mkdirSync(dirname(resolve(path)), { recursive: true });
  const sql = new DatabaseSync(path);
  sql.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('user','admin')),
      password_hash TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL);
  `);
  sql
    .prepare("INSERT OR IGNORE INTO state VALUES (1, ?)")
    .run(JSON.stringify(initialDatabase()));
  try {
    transaction(sql, () => {
      createStorageSchema(sql);
      const meta = sql
        .prepare("SELECT schema_version FROM storage_meta WHERE id=1")
        .get() as { schema_version: number } | undefined;
      if (meta && meta.schema_version > 1)
        throw new Error("数据库存储版本高于当前程序支持范围");
      if (!meta) {
        const db = JSON.parse(
          (
            sql.prepare("SELECT data FROM state WHERE id=1").get() as {
              data: string;
            }
          ).data,
        ) as Database;
        migrateDatabase(db);
        saveStoredDatabase(sql, db);
      } else {
        const db = readDatabase(sql);
        if (migrateDatabase(db)) writeDatabase(sql, db);
      }
      // Preserve the exact legacy bytes as migration evidence; business writes never touch them.
      sql.exec(`CREATE TRIGGER IF NOT EXISTS legacy_state_immutable_update BEFORE UPDATE ON state BEGIN SELECT RAISE(ABORT,'legacy state is read-only migration evidence'); END;
        CREATE TRIGGER IF NOT EXISTS legacy_state_immutable_delete BEFORE DELETE ON state BEGIN SELECT RAISE(ABORT,'legacy state is read-only migration evidence'); END;`);
    });
  } catch (error) {
    sql.close();
    throw error;
  }
  const close = sql.close.bind(sql);
  sql.close = () => {
    preserveBeforeClose(sql);
    close();
  };
  return sql;
}

export function readDatabase(
  sql: DatabaseSync,
  scope?: DatabaseReadScope,
): Database {
  return loadStoredDatabase(sql, scope);
}
export function writeDatabase(sql: DatabaseSync, db: Database) {
  const save = () => saveStoredDatabase(sql, db);
  if (sql.isTransaction) save();
  else transaction(sql, save);
}
export function transaction<T>(sql: DatabaseSync, action: () => T): T {
  sql.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    if (result && typeof (result as { then?: unknown }).then === "function")
      throw new Error("数据库事务中禁止异步操作");
    sql.exec("COMMIT");
    return result;
  } catch (error) {
    sql.exec("ROLLBACK");
    throw error;
  }
}
