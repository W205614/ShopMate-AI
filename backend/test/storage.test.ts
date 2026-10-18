import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openDatabase,
  readDatabase,
  writeDatabase,
  transaction,
  queryPage,
  queryRecord,
} from "../src/database";
import { createSeed } from "../../shared/domain/seed";
import type { Order, Product } from "../../shared/domain/types";

describe("relational business storage", () => {
  it("backfills complete order pagination indexes on reopen and avoids sorting timestamp ties", () => {
    const directory = mkdtempSync(join(tmpdir(), "shopmate-page-index-")),
      path = join(directory, "existing.sqlite");
    let sql = openDatabase(path);
    try {
      const seed = createSeed(),
        base = seed.orders[0]!,
        at = "2026-01-01T00:00:00.000Z";
      seed.orders = Array.from({ length: 10000 }, (_, index) => {
        const id = `same-time-${String(index).padStart(5, "0")}`;
        return {
          ...structuredClone(base),
          id,
          userId: "u1",
          status: "completed" as const,
          createdAt: at,
          items: base.items.map((item, line) => ({
            ...item,
            id: `${id}-line-${line}`,
          })),
        };
      });
      writeDatabase(sql, seed);
      sql.exec(
        "DROP INDEX biz_orders_owner_page; DROP INDEX biz_orders_status_page; DROP INDEX biz_orders_time_page; DROP INDEX biz_orders_owner_status_page;",
      );
      const unindexed = sql
        .prepare(
          "EXPLAIN QUERY PLAN SELECT data FROM biz_orders WHERE user_id=? ORDER BY created_at DESC,key DESC LIMIT 20",
        )
        .all("u1") as { detail: string }[];
      expect(unindexed.some((row) => row.detail.includes("TEMP B-TREE"))).toBe(
        true,
      );
      const legacy = sql.prepare("SELECT data FROM state WHERE id=1").get();
      sql.close();
      sql = openDatabase(path);
      for (const [where, args] of [
        ["user_id=?", ["u1"]],
        ["status=?", ["completed"]],
        ["user_id=? AND status=?", ["u1", "completed"]],
        ["1", []],
      ] as const) {
        const plan = sql
          .prepare(
            `EXPLAIN QUERY PLAN SELECT data FROM biz_orders WHERE ${where} ORDER BY created_at DESC,key DESC LIMIT 20`,
          )
          .all(...args) as { detail: string }[];
        expect(plan.some((row) => row.detail.includes("TEMP B-TREE"))).toBe(
          false,
        );
        expect(plan.some((row) => row.detail.includes("_page"))).toBe(true);
      }
      expect(
        queryPage<Order>(sql, "orders", {
          userId: "u1",
          pageSize: 20,
        }).items.map((order) => order.id),
      ).toEqual(
        seed.orders
          .slice(-20)
          .reverse()
          .map((order) => order.id),
      );
      expect(sql.prepare("SELECT data FROM state WHERE id=1").get()).toEqual(
        legacy,
      );
      expect(
        (
          sql.prepare("SELECT count(*) AS n FROM biz_orders").get() as {
            n: number;
          }
        ).n,
      ).toBe(10000);
      sql.close();
      sql = openDatabase(path);
      expect(
        sql
          .prepare(
            "SELECT count(*) AS n FROM sqlite_master WHERE type='index' AND name IN ('biz_orders_owner_page','biz_orders_status_page','biz_orders_time_page','biz_orders_owner_status_page')",
          )
          .get(),
      ).toEqual({ n: 4 });
    } finally {
      sql.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30000);
  it("totals filtered ledger amounts exactly beyond Number and SQLite sum ranges", () => {
    const sql = openDatabase(":memory:");
    try {
      const db = readDatabase(sql);
      db.ledger = Array.from({ length: 1100 }, (_, i) => ({
        id: `large-${i}`,
        type: "payment" as const,
        amount: Number.MAX_SAFE_INTEGER,
        reference: "large",
        note: "",
        createdAt: new Date().toISOString(),
      }));
      writeDatabase(sql, db);
      const page = queryPage(sql, "ledger", { pageSize: 1, type: "payment" });
      expect(page.items).toHaveLength(1);
      expect(page.totals?.payment).toBe(
        String(BigInt(Number.MAX_SAFE_INTEGER) * 1100n),
      );
      expect(page.totals?.net).toBe(page.totals?.payment);
      expect(queryPage(sql, "ledger", { type: "refund" }).totals?.payment).toBe(
        "0",
      );
    } finally {
      sql.close();
    }
  });
  it("changes only touched records and never writes the legacy migration evidence", () => {
    const sql = openDatabase(":memory:");
    try {
      writeDatabase(sql, createSeed());
      const legacy = sql.prepare("SELECT data FROM state").get();
      sql.exec(`CREATE TEMP TABLE recorded_writes(domain TEXT,key TEXT);
        CREATE TEMP TRIGGER order_update AFTER UPDATE ON biz_orders BEGIN INSERT INTO recorded_writes VALUES('orders',new.key); END;
        CREATE TEMP TRIGGER product_update AFTER UPDATE ON biz_products BEGIN INSERT INTO recorded_writes VALUES('products',new.key); END;`);
      const db = readDatabase(sql);
      db.products[0]!.name = "only this product";
      db.revision++;
      writeDatabase(sql, db);
      expect(sql.prepare("SELECT * FROM recorded_writes").all()).toEqual([
        { domain: "products", key: db.products[0]!.id },
      ]);
      expect(sql.prepare("SELECT data FROM state").get()).toEqual(legacy);
      expect(sql.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(
        queryRecord<Product>(sql, "products", db.products[0]!.id)?.name,
      ).toBe("only this product");
    } finally {
      sql.close();
    }
  });

  it("keeps a returned snapshot stable when an unread collection changes and after close", () => {
    const sql = openDatabase(":memory:");
    const seed = createSeed();
    writeDatabase(sql, seed);
    const before = readDatabase(sql),
      current = readDatabase(sql);
    const original = structuredClone(seed.inventory);
    current.inventory.unshift({
      ...current.inventory[0]!,
      id: "new-movement",
      delta: 1,
    });
    writeDatabase(sql, current);
    expect(before.inventory).toEqual(original);
    sql.close();
    expect(before.products).toEqual(createSeed().products);
  });

  it("includes global pending reservations in scoped writes and preserves excluded order rows", () => {
    const sql = openDatabase(":memory:");
    try {
      const seed = createSeed();
      seed.orders[0]!.userId = "u1";
      seed.orders[0]!.status = "paid";
      seed.orders[1]!.userId = "u2";
      seed.orders[1]!.status = "pending";
      seed.orders[2]!.userId = "u2";
      seed.orders[2]!.status = "completed";
      writeDatabase(sql, seed);
      const excluded = seed.orders[2]!;
      transaction(sql, () => {
        const scoped = readDatabase(sql, { userId: "u1" });
        expect(scoped.orders.some((o) => o.id === excluded.id)).toBe(false);
        expect(
          scoped.orders.some(
            (o) => o.userId === "u2" && o.status === "pending",
          ),
        ).toBe(true);
        scoped.orders.find((o) => o.id === seed.orders[0]!.id)!.status =
          "shipped";
        scoped.revision++;
        writeDatabase(sql, scoped);
      });
      expect(queryRecord(sql, "orders", excluded.id)).toEqual(excluded);
      expect(readDatabase(sql).orders).toHaveLength(seed.orders.length);
    } finally {
      sql.close();
    }
  });

  it("uses SQL owner, exact ID, search, price sorting and bounded page filters", () => {
    const sql = openDatabase(":memory:");
    try {
      writeDatabase(sql, createSeed());
      const own = queryPage<Order>(sql, "orders", {
        userId: "u1",
        pageSize: 2,
      });
      expect(own.total).toBe(
        createSeed().orders.filter((o) => o.userId === "u1").length,
      );
      expect(own.items).toHaveLength(2);
      expect(own.items.every((o) => o.userId === "u1")).toBe(true);
      const order = createSeed().orders[0]!;
      expect(
        queryPage(sql, "orders", { ids: [order.id], search: order.id }).total,
      ).toBe(1);
      expect(queryPage(sql, "orders", { ids: [] }).total).toBe(0);
      const products = queryPage<Product>(sql, "products", {
        sort: "priceAsc",
        pageSize: 1000,
      });
      expect(products.pageSize).toBe(100);
      const prices = products.items.map((p) =>
        Math.min(...p.skus.map((s) => s.price)),
      );
      expect(prices).toEqual([...prices].sort((a, b) => a - b));
    } finally {
      sql.close();
    }
  });

  it("rolls back invalid stock, duplicate SKU identity and async transactions atomically", () => {
    const sql = openDatabase(":memory:");
    try {
      const before = structuredClone(readDatabase(sql));
      const bad = readDatabase(sql);
      bad.products[0]!.skus[0]!.stock = -1;
      expect(() => writeDatabase(sql, bad)).toThrow("CHECK constraint");
      expect(readDatabase(sql)).toEqual(before);
      const duplicate = readDatabase(sql);
      duplicate.products[1]!.skus[0]!.id = duplicate.products[0]!.skus[0]!.id;
      expect(() => writeDatabase(sql, duplicate)).toThrow(
        "Duplicate child identity",
      );
      expect(readDatabase(sql)).toEqual(before);
      expect(() => transaction(sql, () => Promise.resolve(1))).toThrow(
        "禁止异步",
      );
      expect(sql.isTransaction).toBe(false);
    } finally {
      sql.close();
    }
  });
});
