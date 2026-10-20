import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  copyFileSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { openDatabase, readDatabase, writeDatabase } from "../src/database";
import {
  captureStabilityBaseline,
  verifyStability,
  type StabilityBaseline,
} from "../scripts/verify-stability";

let directory: string, path: string, baseline: StabilityBaseline;
const fileDigest = (file: string) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
beforeAll(() => {
  vi.stubEnv("SHOPMATE_ENV", "acceptance");
  vi.stubEnv("LOAD_TEST_ALLOWED", "1");
  directory = mkdtempSync(join(tmpdir(), "shopmate-stability-verifier-"));
  path = join(directory, "isolated.sqlite");
  execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(new URL("../scripts/seed-stability.ts", import.meta.url)),
    ],
    {
      env: {
        ...process.env,
        DATABASE_PATH: path,
        LOAD_HISTORY: "10000",
        LOAD_PASSWORD: "VerifierTest-12345",
      },
      timeout: 30000,
      stdio: "pipe",
    },
  );
  // A standalone copy exercises the same read-only path used for backup and restore targets.
  const sql = new DatabaseSync(path);
  sql.exec("PRAGMA journal_mode=DELETE");
  sql.close();
  baseline = captureStabilityBaseline(path);
}, 40000);
afterAll(() => {
  vi.unstubAllEnvs();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

it("verifies the complete multi-user seed and a copied snapshot without changing either file", () => {
  const before = fileDigest(path),
    files = readdirSync(directory);
  const result = verifyStability(path, baseline);
  expect(result.verified, JSON.stringify(result.checks)).toBe(true);
  expect(result.counts).toMatchObject({
    history: 10000,
    commandResults: 10000,
    users: 51,
  });
  expect(fileDigest(path)).toBe(before);
  expect(readdirSync(directory)).toEqual(files);
  const copied = join(directory, "copied.sqlite");
  copyFileSync(path, copied);
  expect(verifyStability(copied, baseline).verified).toBe(true);
  expect(fileDigest(copied)).toBe(before);
  expect(JSON.stringify(result)).not.toMatch(
    /13800000000|隔离验收地址|load-address/,
  );
});

it("accepts one new paid/refunded lifecycle while detecting duplicate money, changed history, lost commands, and projection damage", () => {
  const copy = join(directory, "lifecycle.sqlite");
  copyFileSync(path, copy);
  let sql = openDatabase(copy);
  const db = readDatabase(sql),
    order = structuredClone(
      db.orders.find((row) => row.id === "history-000000")!,
    );
  order.id = "generated-refund";
  order.userId = "stability-0";
  order.address = {
    ...order.address,
    id: "stability-0-address",
    userId: "stability-0",
  };
  order.status = "refunded";
  order.refundedAmount = 1000;
  order.items = order.items.map((item) => ({
    ...item,
    id: "generated-refund-line",
    refundedQuantity: 1,
  }));
  db.orders.push(order);
  db.afterSales.push({
    id: "generated-sale",
    orderId: order.id,
    userId: order.userId,
    lines: [{ orderItemId: order.items[0]!.id, quantity: 1, amount: 1000 }],
    refundAmount: 1000,
    events: [],
    reason: "isolated",
    description: "",
    status: "refunded",
    requiresReturn: false,
    createdAt: order.createdAt,
    note: "",
  });
  for (const type of ["payment", "refund"] as const)
    db.ledger.push({
      id: `generated-${type}`,
      type,
      amount: 1000,
      reference: order.id,
      note: type === "refund" ? "模拟售后退款 generated-sale" : "isolated",
      createdAt: order.createdAt,
    });
  db.revision++;
  writeDatabase(sql, db);
  sql.close();
  expect(verifyStability(copy, baseline).verified).toBe(true);
  sql = openDatabase(copy);
  sql
    .prepare(
      "INSERT INTO biz_ledger(key,position,data) VALUES('duplicate-payment',999999,?)",
    )
    .run(
      JSON.stringify({
        id: "duplicate-payment",
        type: "payment",
        amount: 0,
        reference: order.id,
        note: "",
        createdAt: order.createdAt,
      }),
    );
  sql.close();
  expect(verifyStability(copy, baseline).checks.paymentExactlyOnce).toBe(false);
  sql = openDatabase(copy);
  sql.prepare("DELETE FROM biz_ledger WHERE key='duplicate-payment'").run();
  sql
    .prepare(
      "UPDATE order_items SET data=json_set(data,'$.name','damaged projection') WHERE id='generated-refund-line'",
    )
    .run();
  sql.close();
  expect(verifyStability(copy, baseline).checks.orderItemProjection).toBe(
    false,
  );
  sql = openDatabase(copy);
  sql
    .prepare(
      "UPDATE biz_orders SET data=json_set(data,'$.address.name','mutated historical value') WHERE key='history-000000'",
    )
    .run();
  sql
    .prepare(
      "UPDATE command_results SET result='\"mutated\"' WHERE method='baseline' AND request_id='baseline-0'",
    )
    .run();
  sql.close();
  const changed = verifyStability(copy, baseline);
  expect(changed.checks.historicalOrdersUnchanged).toBe(false);
  expect(changed.checks.baselineCommandsPreserved).toBe(false);
  sql = openDatabase(copy);
  sql
    .prepare(
      "UPDATE biz_products SET data=json_set(data,'$.skus[0].stock',json_extract(data,'$.skus[0].stock')+1) WHERE key=?",
    )
    .run(order.items[0]!.productId);
  sql
    .prepare(
      "UPDATE product_skus SET stock=stock+1,data=json_set(data,'$.stock',stock+1) WHERE id=?",
    )
    .run(order.items[0]!.skuId);
  sql
    .prepare(
      "UPDATE biz_orders SET data=json_set(data,'$.items[0].quantity',2000000) WHERE key='stability-0-reserved'",
    )
    .run();
  sql
    .prepare(
      "UPDATE biz_carts SET data=json_set(data,'$.userId','nonexistent-account') WHERE key='stability-0-cart-0'",
    )
    .run();
  sql.close();
  const corrupted = verifyStability(copy, baseline);
  expect(corrupted.checks.perSkuStockEqualsInventoryDeltas).toBe(false);
  expect(corrupted.checks.reservationsWithinStock).toBe(false);
  expect(corrupted.checks.noOrphanOwnership).toBe(false);
});

it("fails closed before opening an unrelated path unless the explicit acceptance guards are set", () => {
  vi.stubEnv("SHOPMATE_ENV", "production");
  expect(() =>
    captureStabilityBaseline(join(directory, "not-created.sqlite")),
  ).toThrow("EXPLICIT_ISOLATED_ACCEPTANCE_DATASET_REQUIRED");
  expect(readdirSync(directory)).not.toContain("not-created.sqlite");
  vi.stubEnv("SHOPMATE_ENV", "acceptance");
  const unrelated = join(directory, "unrelated.sqlite"),
    sql = openDatabase(unrelated);
  sql.close();
  expect(() => captureStabilityBaseline(unrelated)).toThrow(
    "ISOLATED_STABILITY_ACCOUNTS_REQUIRED",
  );
});
