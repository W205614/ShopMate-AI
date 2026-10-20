import { afterEach, describe, expect, it, vi } from "vitest";
import {
  openDatabase,
  readDatabase,
  writeDatabase,
  queryRecord,
  transaction,
} from "../src/database";
import { context } from "../src/repository";
import { commerceApi, expirePendingOrders } from "../src/commerce";
import { runDueJobs } from "../src/jobs";
import { enqueue, ensureRuntimeSchema } from "../src/runtime";
import { createSeed } from "../../shared/domain/seed";
import type { Database } from "../../shared/domain/types";

afterEach(() => vi.restoreAllMocks());
const user = { id: "u1", name: "member", role: "user" as const };
function protectUnrelated() {
  const parse = JSON.parse;
  return vi.spyOn(JSON, "parse").mockImplementation((value, reviver) => {
    if (value.includes("EXCLUDED_RECORD"))
      throw new Error("unrelated collection row parsed");
    return parse(value, reviver);
  });
}
function run<T>(
  sql: ReturnType<typeof openDatabase>,
  method: string,
  args: unknown[],
  action: () => Promise<T>,
  requestId: string = crypto.randomUUID(),
) {
  ensureRuntimeSchema(sql);
  return context.run(
    {
      sql,
      user,
      admin: null,
      command: { method, args, requestId, fingerprint: JSON.stringify(args) },
    },
    action,
  );
}

describe("partial domain writes", () => {
  it("updates owned cart/address and quotes without loading other users or successful quotes", async () => {
    const sql = openDatabase(":memory:");
    try {
      const seed = createSeed();
      seed.carts = [
        {
          id: "mine",
          userId: "u1",
          productId: "p01",
          skuId: "p01-s1",
          quantity: 1,
          selected: true,
        },
        ...Array.from({ length: 2000 }, (_, i) => ({
          id: `other-${i}`,
          userId: "EXCLUDED_RECORD",
          productId: "p01",
          skuId: "p01-s1",
          quantity: 1,
          selected: true,
        })),
      ];
      seed.addresses.push({
        ...seed.addresses[0]!,
        id: "foreign-address",
        userId: "EXCLUDED_RECORD",
      });
      seed.checkoutQuotes = [
        {
          id: "historic-quote",
          userId: "u1",
          orderId: seed.orders[0]!.id,
          expiresAt: "2020-01-01T00:00:00Z",
          fingerprint: "EXCLUDED_RECORD",
        } as Database["checkoutQuotes"][number],
      ];
      writeDatabase(sql, seed);
      const foreign = sql
        .prepare("SELECT data FROM biz_carts WHERE key='other-1'")
        .get();
      const spy = protectUnrelated();
      await run(sql, "updateCart", ["mine", { quantity: 2 }], () =>
        commerceApi.updateCart("mine", { quantity: 2 }),
      );
      const address = {
        ...seed.addresses.find((a) => a.userId === "u1")!,
        detail: "updated address",
      };
      await run(sql, "saveAddress", [address], () =>
        commerceApi.saveAddress(address),
      );
      const input = {
        addressId: address.id,
        source: {
          type: "buyNow" as const,
          productId: "p01",
          skuId: "p01-s1",
          quantity: 1,
        },
      };
      const quote = await run(sql, "quoteCheckout", [input], () =>
        commerceApi.quoteCheckout(input),
      );
      const create = { quoteId: quote.id, requestId: "domain-once" };
      const id = await run(
        sql,
        "createOrder",
        [create],
        () => commerceApi.createOrder(create),
        "http-once",
      );
      expect(
        await run(
          sql,
          "createOrder",
          [create],
          () => commerceApi.createOrder(create),
          "http-once",
        ),
      ).toBe(id);
      spy.mockRestore();
      expect(
        sql.prepare("SELECT data FROM biz_carts WHERE key='other-1'").get(),
      ).toEqual(foreign);
      expect(sql.prepare("SELECT count(*) n FROM biz_carts").get()!.n).toBe(
        2001,
      );
      expect(
        queryRecord<{ quantity: number }>(sql, "carts", "mine")!.quantity,
      ).toBe(2);
      expect(queryRecord(sql, "checkoutQuotes", "historic-quote")).toEqual(
        seed.checkoutQuotes[0],
      );
      expect(
        sql.prepare("SELECT count(*) n FROM biz_orders WHERE key=?").get(id)!.n,
      ).toBe(1);
    } finally {
      sql.close();
    }
  });

  it("rejects excluded key collisions and foreign-owner inserts without altering stored rows", () => {
    const sql = openDatabase(":memory:");
    try {
      const seed = createSeed();
      seed.carts = [
        {
          id: "foreign",
          userId: "u2",
          productId: "p01",
          skuId: "p01-s1",
          quantity: 1,
          selected: true,
        },
      ];
      writeDatabase(sql, seed);
      const original = queryRecord(sql, "carts", "foreign");
      expect(() =>
        transaction(sql, () => {
          const db = readDatabase(sql, {
            domains: { carts: { userId: "u1" } },
          });
          db.carts.push({ ...seed.carts[0]!, userId: "u1" });
          writeDatabase(sql, db);
        }),
      ).toThrow("SCOPED_RECORD_COLLISION");
      expect(() =>
        transaction(sql, () => {
          const db = readDatabase(sql, {
            domains: { carts: { userId: "u1" } },
          });
          db.carts.push({ ...seed.carts[0]!, id: "new-foreign" });
          writeDatabase(sql, db);
        }),
      ).toThrow("SCOPED_OWNER_MISMATCH");
      expect(queryRecord(sql, "carts", "foreign")).toEqual(original);
      expect(queryRecord(sql, "carts", "new-foreign")).toBeUndefined();
    } finally {
      sql.close();
    }
  });

  it("expires only unused quotes and old bindings while preserving finalized replay evidence", () => {
    const sql = openDatabase(":memory:");
    try {
      const seed = createSeed();
      seed.orders = [];
      seed.checkoutQuotes = [
        {
          id: "done",
          orderId: "historic-order",
          userId: "u1",
          expiresAt: "2020-01-01",
          fingerprint: "EXCLUDED_RECORD",
        },
        { id: "stale", userId: "u2", expiresAt: "2020-01-01" },
        {
          id: "valid",
          userId: "u2",
          expiresAt: "2100-01-01",
          fingerprint: "EXCLUDED_RECORD",
        },
      ] as Database["checkoutQuotes"];
      seed.orderRequests = [
        {
          userId: "u2",
          requestId: "old",
          quoteId: "stale",
          orderId: "old",
          createdAt: "2020-01-01",
        },
      ];
      writeDatabase(sql, seed);
      const spy = protectUnrelated();
      expirePendingOrders(sql);
      spy.mockRestore();
      expect(readDatabase(sql).checkoutQuotes.map((q) => q.id)).toEqual([
        "done",
        "valid",
      ]);
      expect(readDatabase(sql).orderRequests).toEqual([]);
    } finally {
      sql.close();
    }
  });

  it("delivers notifications with one insert and preserves snapshot and retry semantics", () => {
    const sql = openDatabase(":memory:");
    try {
      const seed = createSeed();
      seed.notifications = Array.from({ length: 2000 }, (_, i) => ({
        id: `notice-${i}`,
        userId: "u2",
        text: "EXCLUDED_RECORD",
        read: false,
        createdAt: "2020-01-01",
      }));
      writeDatabase(sql, seed);
      ensureRuntimeSchema(sql);
      enqueue(
        sql,
        "notification",
        { userId: "u1", text: "new notice" },
        "delivery-once",
      );
      const before = readDatabase(sql);
      const spy = protectUnrelated();
      runDueJobs(sql);
      sql
        .prepare(
          "UPDATE job_queue SET status='pending',run_after=0 WHERE id='delivery-once'",
        )
        .run();
      runDueJobs(sql);
      spy.mockRestore();
      expect(
        sql.prepare("SELECT count(*) n FROM biz_notifications").get()!.n,
      ).toBe(2001);
      expect(before.notifications).toHaveLength(2000);
      expect(
        sql
          .prepare("SELECT status FROM job_queue WHERE id='delivery-once'")
          .get()!.status,
      ).toBe("done");
    } finally {
      sql.close();
    }
  });
});
