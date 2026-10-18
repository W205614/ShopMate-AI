// Read-only snapshot comparison: all SQLite connections are read-only, snapshot transactions.
// Container: node compare-database-snapshots.mjs /app/backups/preupgrade.sqlite
// Host rehearsal: node compare-database-snapshots.mjs baseline.sqlite migrated.sqlite
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const sha = (value) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const equal = (a, b) => sha(a) === sha(b);
const hasTable = (sql, name) => !!sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
function oldShape(actual, original, root = false) {
  if (Array.isArray(original)) {
    if (!Array.isArray(actual) || actual.length !== original.length) throw new Error("BUSINESS_SHAPE_CHANGED");
    return original.map((item, index) => oldShape(actual[index], item));
  }
  if (original && typeof original === "object") {
    if (!actual || typeof actual !== "object") throw new Error("BUSINESS_SHAPE_CHANGED");
    return Object.fromEntries(Object.entries(original).filter(([key]) => !root || key !== "version")
      .map(([key, item]) => [key, oldShape(actual[key], item)]));
  }
  return actual;
}
function normalized(sql) {
  const meta = sql.prepare("SELECT schema_version,version,revision FROM storage_meta WHERE id=1").get();
  if (!meta) throw new Error("STORAGE_METADATA_MISSING");
  const db = { version: meta.version, revision: meta.revision };
  for (const { name, kind } of sql.prepare("SELECT name,kind FROM storage_domains ORDER BY name").all()) {
    if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(name)) throw new Error("INVALID_STORAGE_DOMAIN");
    const table = "biz_" + name.replace(/[A-Z]/g, v => "_" + v.toLowerCase());
    const rows = sql.prepare(`SELECT key,data FROM ${table} ORDER BY position,key`).all();
    if (kind === "array") db[name] = rows.map(row => JSON.parse(row.data));
    else if (kind === "object") db[name] = Object.fromEntries(rows.map(row => [row.key, JSON.parse(row.data)]));
    else if (kind === "value" && rows.length === 1) db[name] = JSON.parse(rows[0].data);
    else throw new Error("INVALID_STORAGE_SHAPE");
  }
  return { db, meta };
}
function identity(sql) {
  return { accounts: sql.prepare("SELECT * FROM accounts ORDER BY id").all(),
    sessions: sql.prepare("SELECT * FROM sessions ORDER BY token_hash").all() };
}
function originalsPreserved(original, actual, key) {
  if (original.length !== actual.length) return false;
  const rows = new Map(actual.map(row => [row[key], row]));
  return original.every(row => rows.has(row[key]) && equal(row, rows.get(row[key])));
}
function inventory(db) {
  const stocks = new Map(), balances = new Map();
  let valid = true, total = 0n, delta = 0n;
  for (const product of db.products) for (const sku of product.skus) {
    if (stocks.has(sku.id) || !Number.isSafeInteger(sku.stock) || sku.stock < 0) valid = false;
    stocks.set(sku.id, { stock: BigInt(sku.stock), productId: product.id }); total += BigInt(sku.stock);
  }
  for (const movement of db.inventory) {
    if (!Number.isSafeInteger(movement.delta) || stocks.get(movement.skuId)?.productId !== movement.productId) valid = false;
    balances.set(movement.skuId, (balances.get(movement.skuId) ?? 0n) + BigInt(movement.delta)); delta += BigInt(movement.delta);
  }
  for (const [key, value] of stocks) if (value.stock !== (balances.get(key) ?? 0n)) valid = false;
  return { valid, skuCount: stocks.size, stockTotal: String(total), movementDeltaTotal: String(delta),
    balancesSha256: sha([...stocks].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, String(value.stock), String(balances.get(key) ?? 0n)])) };
}
function money(db) {
  const sum = (rows, field) => String(rows.reduce((value, row) => value + BigInt(row[field] ?? 0), 0n));
  return { orderTotal: sum(db.orders, "total"), refundedTotal: sum(db.orders, "refundedAmount"),
    payment: sum(db.ledger.filter(row => row.type === "payment"), "amount"),
    refund: sum(db.ledger.filter(row => row.type === "refund"), "amount"),
    purchase: sum(db.ledger.filter(row => row.type === "purchase"), "amount") };
}
function facts(db, identities) {
  const counts = Object.fromEntries(Object.entries(db).filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, value.length]));
  return { counts: { ...counts, accounts: identities.accounts.length, sessions: identities.sessions.length },
    inventory: inventory(db), money: money(db), businessSha256: sha(db), identitySha256: sha(identities) };
}
const connections = [];
try {
  const baselinePath = process.argv[2], livePath = process.argv[3] ?? process.env.DATABASE_PATH;
  if (!baselinePath || !livePath || resolve(baselinePath) === resolve(livePath)) throw new Error("TWO_DISTINCT_DATABASE_PATHS_REQUIRED");
  for (const path of [baselinePath, livePath]) {
    const sql = new DatabaseSync(path, { readOnly: true }); connections.push(sql);
    sql.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000; BEGIN");
  }
  const [baseline, live] = connections;
  const baselineLegacy = baseline.prepare("SELECT data FROM state WHERE id=1").get().data;
  const liveLegacy = live.prepare("SELECT data FROM state WHERE id=1").get().data;
  const original = hasTable(baseline, "storage_meta") ? normalized(baseline).db : JSON.parse(baselineLegacy);
  const current = normalized(live), originalIdentity = identity(baseline), currentIdentity = identity(live);
  let businessPreserved = false;
  try { businessPreserved = equal(oldShape(current.db, original, true), oldShape(original, original, true)); } catch { /* fixed boolean only */ }
  const before = facts(original, originalIdentity), after = facts(current.db, currentIdentity);
  const projectedSkus = live.prepare('SELECT id,product_id,price,stock,data FROM product_skus').all();
  const jsonSkus = new Map(current.db.products.flatMap(product => product.skus.map(sku => [sku.id, {productId:product.id, sku}])));
  const skuProjections = projectedSkus.length === jsonSkus.size && projectedSkus.every(row => {
    const original = jsonSkus.get(row.id);
    return original && row.product_id === original.productId && row.price === original.sku.price && row.stock === original.sku.stock && equal(JSON.parse(row.data), original.sku);
  });
  const integrity = sql => sql.prepare("PRAGMA integrity_check").all().every(row => Object.values(row)[0] === "ok");
  const checks = {
    readOnlySnapshots: connections.every(sql => sql.isTransaction),
    legacyBytes: baselineLegacy === liveLegacy,
    existingBusinessFields: businessPreserved,
    originalAccounts: originalsPreserved(originalIdentity.accounts, currentIdentity.accounts, "id"),
    originalSessions: originalsPreserved(originalIdentity.sessions, currentIdentity.sessions, "token_hash"),
    perSkuInventory: before.inventory.valid && after.inventory.valid,
    skuProjections,
    integrity: integrity(baseline) && integrity(live),
    foreignKeys: baseline.prepare("PRAGMA foreign_key_check").all().length === 0 && live.prepare("PRAGMA foreign_key_check").all().length === 0,
    currentVersion: current.meta.version === 4,
  };
  console.log(JSON.stringify({ checks, meta: { baselineVersion: original.version, live: current.meta }, before, after,
    legacySha256: createHash("sha256").update(baselineLegacy).digest("hex") }, null, 2));
  if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
} catch (error) {
  console.log(JSON.stringify({ checks: { verificationCompleted: false }, code: "READ_ONLY_DEPLOYMENT_VERIFICATION_FAILED" }));
  process.exitCode = 1;
} finally {
  for (const sql of connections.reverse()) {
    try { if (sql.isTransaction) sql.exec("ROLLBACK"); } catch { /* no data writes */ }
    try { sql.close(); } catch { /* fixed failure result already emitted */ }
  }
}
