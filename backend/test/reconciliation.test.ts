import { expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase, transaction } from "../src/database";
import { reconcile } from "../src/reconciliation";
import { createReconciliationReader } from "../src/reconciliation-reader";

it("reports payment, refund, purchase and orphan differences with exact string amounts", () => {
  const sql = openDatabase(":memory:");
  try {
    sql
      .prepare("INSERT INTO biz_orders(key,position,data) VALUES('order',0,?)")
      .run(
        JSON.stringify({
          id: "order",
          total: 1234,
          refundedAmount: 100,
          status: "paid",
          paidAt: "2026-01-01",
        }),
      );
    sql
      .prepare(
        "INSERT INTO biz_purchase_orders(key,position,data) VALUES('po',0,?)",
      )
      .run(JSON.stringify({ receipts: [{ id: "receipt", amount: 200 }] }));
    const insert = sql.prepare(
      "INSERT INTO biz_ledger(key,position,data) VALUES(?,?,?)",
    );
    for (const [index, entry] of [
      { id: "pay", type: "payment", reference: "order", amount: 1000 },
      { id: "orphan", type: "payment", reference: "missing", amount: 5 },
      {
        id: "purchase",
        type: "purchase",
        reference: "receipt",
        amount: 100,
        inventoryMovementId: "missing",
      },
    ].entries())
      insert.run(entry.id, index, JSON.stringify(entry));
    expect(reconcile(sql)).toMatchObject({
      balanced: false,
      totals: { income: "1005", refund: "0", purchase: "100", net: "905" },
      issues: [
        {
          kind: "orphan-inventory",
          reference: "purchase",
          expected: "0",
          actual: "100",
        },
        {
          kind: "orphan-ledger",
          reference: "orphan",
          expected: "0",
          actual: "5",
        },
        {
          kind: "payment",
          reference: "order",
          expected: "1234",
          actual: "1000",
        },
        {
          kind: "purchase",
          reference: "receipt",
          expected: "200",
          actual: "100",
        },
        { kind: "refund", reference: "order", expected: "100", actual: "0" },
      ],
    });
  } finally {
    sql.close();
  }
});

it("aggregates a history beyond SQLite's signed 64-bit SUM without rounding or overflow", () => {
  const sql = openDatabase(":memory:");
  try {
    transaction(sql, () => {
      const insert = sql.prepare(
        "INSERT INTO biz_ledger(key,position,data) VALUES(?,?,?)",
      );
      for (let i = 0; i < 1025; i++)
        insert.run(
          `large-${i}`,
          i,
          JSON.stringify({
            type: "payment",
            reference: "missing",
            amount: Number.MAX_SAFE_INTEGER,
          }),
        );
    });
    expect(reconcile(sql).totals.income).toBe(
      String(1025n * BigInt(Number.MAX_SAFE_INTEGER)),
    );
  } finally {
    sql.close();
  }
});

it("shares one read-only child for concurrent requests while leaving the parent event loop responsive", async () => {
  const folder = mkdtempSync(join(tmpdir(), "shopmate-reconciliation-"));
  const sql = openDatabase(join(folder, "history.sqlite"));
  try {
    transaction(sql, () => {
      const insert = sql.prepare(
        "INSERT INTO biz_orders(key,position,data) VALUES(?,?,?)",
      );
      const ledger = sql.prepare(
        "INSERT INTO biz_ledger(key,position,data) VALUES(?,?,?)",
      );
      for (let i = 0; i < 50000; i++) {
        insert.run(
          `history-${i}`,
          i,
          JSON.stringify({
            id: `history-${i}`,
            status: i % 2 === 0 ? "completed" : "cancelled",
            paidAt: i % 2 === 0 ? "2026-01-01" : undefined,
            total: 1000,
            refundedAmount: 0,
          }),
        );
        if (i % 2 === 0)
          ledger.run(
            `pay-${i}`,
            i,
            JSON.stringify({
              type: "payment",
              reference: `history-${i}`,
              amount: 1000,
            }),
          );
      }
    });
    const changes = sql.prepare("SELECT total_changes() n").get()!.n;
    const read = createReconciliationReader(sql);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    try {
      const first = read();
      expect(read()).toBe(first);
      const result = await first;
      expect(result).toMatchObject({ balanced: true, issues: [] });
      expect(result.totals.income).toBe("25000000");
      expect(ticks).toBeGreaterThan(2);
      expect(sql.prepare("SELECT total_changes() n").get()!.n).toBe(changes);
      expect(result.revision).toBe(
        sql.prepare("SELECT revision FROM storage_meta").get()!.revision,
      );
    } finally {
      clearInterval(timer);
    }
  } finally {
    sql.close();
  }
});

it("reports a failed worker explicitly and releases the single-flight slot", async () => {
  const sql = new DatabaseSync(
    join(
      mkdtempSync(join(tmpdir(), "shopmate-reconciliation-invalid-")),
      "empty.sqlite",
    ),
  );
  try {
    const read = createReconciliationReader(sql);
    await expect(read()).rejects.toMatchObject({
      status: 503,
      code: "RECONCILIATION_FAILED",
    });
    await expect(read()).rejects.toMatchObject({
      code: "RECONCILIATION_FAILED",
    });
  } finally {
    sql.close();
  }
});
