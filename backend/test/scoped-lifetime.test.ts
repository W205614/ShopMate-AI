import { afterEach, describe, expect, it, vi } from "vitest";
import {
  openDatabase,
  readDatabase,
  transaction,
  writeDatabase,
} from "../src/database";
import { releaseSnapshot, insertStoredRecord } from "../src/storage";
import { context } from "../src/repository";
import { commerceApi, expirePendingOrders } from "../src/commerce";
import { createSeed } from "../../shared/domain/seed";
import type { Database } from "../../shared/domain/types";
import { ensureRuntimeSchema } from "../src/runtime";
import { dashboard } from "../src/dashboard";
import type { DatabaseReadScope } from "../src/storage";

afterEach(() => vi.restoreAllMocks());

function fixture() {
  const sql = openDatabase(":memory:"),
    seed = createSeed();
  seed.orders.forEach((order) => {
    order.status = "completed";
  });
  seed.afterSales = [];
  seed.notifications = Array.from({ length: 100 }, (_, index) => ({
    id: `old-notification-${index}`,
    userId: "u2",
    text: "historical notice",
    read: false,
    createdAt: "2020-01-01T00:00:00.000Z",
  }));
  seed.carts = [
    {
      id: "mine",
      userId: "u1",
      productId: "p01",
      skuId: "p01-s1",
      selected: true,
      quantity: 1,
    },
  ];
  writeDatabase(sql, seed);
  ensureRuntimeSchema(sql);
  return { sql, seed };
}

function observeNotificationReads(sql: ReturnType<typeof openDatabase>) {
  const queries: string[] = [],
    prepare = sql.prepare.bind(sql);
  vi.spyOn(sql, "prepare").mockImplementation((query) => {
    // Record actual collection reads, not JSON decoding or unrelated metadata checks.
    if (
      /^\s*SELECT\s+key,position,data\s+FROM\s+biz_notifications\b/i.test(query)
    )
      queries.push(query);
    return prepare(query);
  });
  return queries;
}

function deliver(sql: ReturnType<typeof openDatabase>) {
  transaction(sql, () =>
    insertStoredRecord(
      sql,
      "notifications",
      {
        id: "new-notification",
        userId: "u1",
        text: "new notice",
        read: false,
        createdAt: new Date().toISOString(),
      },
      true,
    ),
  );
}

describe("scoped snapshot lifetime and position ordering", () => {
  it("captures owner, keys and order IDs before caller-owned selectors are mutated", () => {
    const { sql, seed } = fixture();
    try {
      seed.carts.push({ ...seed.carts[0]!, id: "foreign", userId: "u2" });
      writeDatabase(sql, seed);
      const scope: DatabaseReadScope = {
        pendingOnly: true,
        orderIds: [seed.orders[0]!.id],
        domains: { carts: { userId: "u1", keys: ["mine"] } },
      };
      const db = readDatabase(sql, scope);
      scope.orderIds![0] = seed.orders[1]!.id;
      scope.domains!.carts!.userId = "u2";
      scope.domains!.carts!.keys![0] = "foreign";
      expect(db.carts.map((cart) => cart.id)).toEqual(["mine"]);
      expect(db.orders.map((order) => order.id)).toEqual([seed.orders[0]!.id]);
      db.carts[0]!.quantity = 2;
      db.revision++;
      writeDatabase(sql, db);
      expect(
        sql
          .prepare(
            "SELECT json_extract(data,'$.quantity') quantity FROM biz_carts WHERE key='mine'",
          )
          .get()!.quantity,
      ).toBe(2);
      expect(
        sql
          .prepare(
            "SELECT json_extract(data,'$.quantity') quantity FROM biz_carts WHERE key='foreign'",
          )
          .get()!.quantity,
      ).toBe(1);
      releaseSnapshot(db);
    } finally {
      sql.close();
    }
  });

  it("reads dashboard revision without registering an unread snapshot for notification preservation", () => {
    const { sql } = fixture();
    try {
      const revision = sql
        .prepare("SELECT revision FROM storage_meta WHERE id=1")
        .get()!.revision;
      const queries = observeNotificationReads(sql);
      expect(
        dashboard(sql, {
          id: "owner",
          role: "admin",
          name: "owner",
          staffRole: "owner",
        }).revision,
      ).toBe(revision);
      deliver(sql);
      expect(queries).toEqual([]);
    } finally {
      sql.close();
    }
  });

  it("prepends a new order when every existing historical order is excluded", () => {
    const { sql, seed } = fixture();
    try {
      const originalPositions = sql
        .prepare("SELECT key,position FROM biz_orders ORDER BY position")
        .all();
      transaction(sql, () => {
        const db = readDatabase(sql, { pendingOnly: true });
        expect(db.orders).toEqual([]);
        const base = seed.orders[0]!;
        db.orders.unshift({
          ...structuredClone(base),
          id: "fresh-order",
          status: "pending",
          items: base.items.map((item, index) => ({
            ...item,
            id: `fresh-item-${index}`,
          })),
        });
        db.revision++;
        writeDatabase(sql, db);
        releaseSnapshot(db);
      });
      const stored = sql
        .prepare("SELECT key,position FROM biz_orders ORDER BY position")
        .all();
      expect(stored[0]!.key).toBe("fresh-order");
      expect(stored.slice(1)).toEqual(originalPositions);
    } finally {
      sql.close();
    }
  });

  it("prepends a new after-sale when no prior after-sale belongs to the explicit order scope", () => {
    const { sql, seed } = fixture();
    try {
      const source = createSeed().afterSales[0]!;
      // This domain permits flexible line contents; the foreign key must reference an existing order.
      const old = {
        ...structuredClone(source),
        id: "excluded-sale",
        orderId: seed.orders[0]!.id,
      };
      seed.afterSales = [old];
      writeDatabase(sql, seed);
      transaction(sql, () => {
        const db = readDatabase(sql, {
          pendingOnly: true,
          orderIds: [seed.orders[1]!.id],
        });
        expect(db.afterSales).toEqual([]);
        db.afterSales.unshift({
          ...structuredClone(old),
          id: "fresh-sale",
          orderId: seed.orders[1]!.id,
        });
        db.revision++;
        writeDatabase(sql, db);
        releaseSnapshot(db);
      });
      expect(
        sql.prepare("SELECT key FROM biz_after_sales ORDER BY position").all(),
      ).toEqual([{ key: "fresh-sale" }, { key: "excluded-sale" }]);
    } finally {
      sql.close();
    }
  });

  it("does not copy a released transient snapshot's unread notification collection", () => {
    const { sql } = fixture();
    try {
      const transient = readDatabase(sql, { pendingOnly: true });
      void transient.products;
      releaseSnapshot(transient);
      // Keep the object strongly reachable: this verifies release independently of GC timing.
      const queries = observeNotificationReads(sql);
      deliver(sql);
      expect(queries).toEqual([]);
      expect(transient.products[0]!.id).toBe("p01");
      expect(
        sql.prepare("SELECT count(*) n FROM biz_notifications").get()!.n,
      ).toBe(101);
    } finally {
      sql.close();
    }
  });

  it("releases successful and failed command snapshots and expiry snapshots before notification delivery", async () => {
    const { sql } = fixture();
    try {
      const run = (cartId: string) =>
        context.run(
          {
            sql,
            user: { id: "u1", role: "user", name: "member" },
            admin: null,
            command: {
              method: "updateCart",
              args: [cartId, { selected: false }],
              requestId: crypto.randomUUID(),
              fingerprint: cartId,
            },
          },
          () => commerceApi.updateCart(cartId, { selected: false }),
        );
      await run("mine");
      await expect(run("missing")).rejects.toThrow("购物车条目不存在");
      expirePendingOrders(sql);
      const queries = observeNotificationReads(sql);
      deliver(sql);
      expect(queries).toEqual([]);
    } finally {
      sql.close();
    }
  });

  it("preserves an unreleased public snapshot's old collection while the live database advances", () => {
    const { sql, seed } = fixture();
    try {
      const publicSnapshot: Database = readDatabase(sql);
      const queries = observeNotificationReads(sql);
      deliver(sql);
      expect(queries).toHaveLength(1);
      expect(publicSnapshot.notifications).toEqual(seed.notifications);
      expect(
        sql.prepare("SELECT count(*) n FROM biz_notifications").get()!.n,
      ).toBe(101);
      releaseSnapshot(publicSnapshot);
    } finally {
      sql.close();
    }
  });
});
