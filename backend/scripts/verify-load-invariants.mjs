// Read-only acceptance verifier. Run AFTER the isolated load driver stops.
// docker exec -i -e SHOPMATE_ENV=acceptance -e LOAD_TEST_ALLOWED=1 -e LOAD_HISTORY=0 \
//   <isolated-api-container> node --input-type=module < backend/scripts/verify-load-invariants.mjs
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

const history = Number(process.env.LOAD_HISTORY);
if (process.env.SHOPMATE_ENV !== "acceptance" || process.env.LOAD_TEST_ALLOWED !== "1" || ![0, 10000].includes(history)) {
  throw new Error("EXPLICIT_ISOLATED_ACCEPTANCE_DATASET_REQUIRED");
}
const canonical = (v) => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object"
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)])) : v;
const hash = (v) => createHash("sha256").update(JSON.stringify(canonical(v))).digest("hex");
const sorted = (rows) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
const equalRows = (a, b) => hash(sorted(a)) === hash(sorted(b));
const sum = (rows, field) => rows.reduce((n, r) => n + BigInt(r[field] ?? 0), 0n);
const checks = {};
let sql;
try {
  sql = new DatabaseSync(process.env.DATABASE_PATH || "/app/data/shopmate.sqlite", { readOnly: true });
  sql.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000; BEGIN");
  const now = Date.now();
  const meta = sql.prepare("SELECT schema_version,version,revision FROM storage_meta WHERE id=1").get();
  const original = JSON.parse(sql.prepare("SELECT data FROM state WHERE id=1").get().data);
  const records = (table) => sql.prepare(`SELECT data FROM ${table} ORDER BY key`).all().map((r) => JSON.parse(r.data));
  const products = records("biz_products"), orders = records("biz_orders"), inventory = records("biz_inventory"), ledger = records("biz_ledger"), purchases = records("biz_purchase_orders");
  const user = sql.prepare("SELECT id FROM accounts WHERE username='loaduser' AND role='user'").get();
  if (!user) throw new Error("ISOLATED_LOAD_ACCOUNT_MISSING");
  const expectedProducts = structuredClone(original.products);
  const firstProduct = expectedProducts[0], firstSku = firstProduct.skus[0], before = firstSku.stock;
  firstSku.stock = 1_000_000;
  const at = "2026-01-01T00:00:00.000Z";
  const expectedInventory = [...original.inventory, {
    id: "load-initial-adjustment", productId: firstProduct.id, skuId: firstSku.id,
    delta: 1_000_000 - before + history, reason: "隔离容量数据期初", createdAt: at,
  }];
  if (history) expectedInventory.push({ id: "load-historical-sales", productId: firstProduct.id, skuId: firstSku.id,
    delta: -history, reason: "隔离历史销售汇总", createdAt: at });
  const expectedOrders = [], expectedLedger = [];
  const address = { id: "load-address", userId: user.id, name: "验收", phone: "13800000000",
    province: "上海", region: "上海", detail: "隔离验收地址", isDefault: true };
  for (let i = 0; i < history; i++) {
    const id = `history-${String(i).padStart(6, "0")}`;
    expectedOrders.push({ id, userId: user.id, items: [{ id: id + "-line", productId: firstProduct.id,
      skuId: firstSku.id, name: firstProduct.name, skuName: firstSku.name, image: firstProduct.images[0],
      price: 1000, quantity: 1, discount: 0, total: 1000, refundedQuantity: 0 }],
      subtotal: 1000, discount: 0, total: 1000, refundedAmount: 0, status: "completed", address,
      createdAt: at, paidAt: at, shippedAt: at, completedAt: at, events: [] });
    expectedLedger.push({ id: "payment-" + id, type: "payment", amount: 1000,
      reference: id, note: "隔离历史收款", createdAt: at });
  }

  checks.readOnlySnapshot = sql.isTransaction && sql.prepare("PRAGMA query_only").get().query_only === 1;
  checks.storageV4 = meta.schema_version === 1 && meta.version === 4;
  checks.integrity = sql.prepare("PRAGMA integrity_check").all().every((r) => Object.values(r)[0] === "ok");
  checks.foreignKeys = sql.prepare("PRAGMA foreign_key_check").all().length === 0;
  checks.seedProductsUnchanged = equalRows(products, expectedProducts);
  checks.noOrdersCreatedOrMutated = equalRows(orders, expectedOrders);
  checks.noInventoryCreatedOrMutated = equalRows(inventory, expectedInventory);
  checks.noLedgerCreatedOrMutated = equalRows(ledger, expectedLedger);

  const skus = new Map(), balances = new Map(), reservations = new Map();
  let validStock = true, validMovement = true;
  for (const product of products) for (const sku of product.skus) {
    validStock &&= Number.isSafeInteger(sku.stock) && sku.stock >= 0 && !skus.has(sku.id);
    skus.set(sku.id, { productId: product.id, sku });
  }
  for (const movement of inventory) {
    validMovement &&= Number.isSafeInteger(movement.delta) && skus.get(movement.skuId)?.productId === movement.productId;
    balances.set(movement.skuId, (balances.get(movement.skuId) ?? 0n) + BigInt(movement.delta));
  }
  for (const order of orders) if (order.status === "pending" && order.inventoryPolicy === "reserved-v1" && new Date(order.expiresAt).getTime() > now)
    for (const item of order.items) reservations.set(item.skuId, (reservations.get(item.skuId) ?? 0n) + BigInt(item.quantity));
  checks.nonnegativeStocks = validStock;
  checks.perSkuStockEqualsInventoryDeltas = validMovement && [...skus].every(([id, { sku }]) => BigInt(sku.stock) === (balances.get(id) ?? 0n));
  checks.reservationsWithinStock = [...reservations].every(([id, quantity]) => quantity >= 0n && skus.has(id) && quantity <= BigInt(skus.get(id).sku.stock));
  const projected = sql.prepare("SELECT id,product_id,price,stock,data FROM product_skus").all();
  checks.skuProjection = projected.length === skus.size && projected.every((row) => {
    const source = skus.get(row.id);
    return source && row.product_id === source.productId && row.price === source.sku.price && row.stock === source.sku.stock && hash(JSON.parse(row.data)) === hash(source.sku);
  });
  const lines = new Map(orders.flatMap((order) => order.items.map((item) => [item.id, { orderId: order.id, item }])));
  const projectedItems = sql.prepare("SELECT id,order_id,product_id,sku_id,quantity,total,refunded_quantity,data FROM order_items").all();
  checks.orderItemProjection = projectedItems.length === lines.size && projectedItems.every((row) => {
    const source = lines.get(row.id);
    return source && row.order_id === source.orderId && row.product_id === source.item.productId && row.sku_id === source.item.skuId
      && row.quantity === source.item.quantity && row.total === source.item.total && row.refunded_quantity === source.item.refundedQuantity && hash(JSON.parse(row.data)) === hash(source.item);
  });

  const money = { payment: 0n, refund: 0n, purchase: 0n }, actual = new Map(), orderIds = new Set(orders.map((o) => o.id));
  const receipts = new Map(purchases.flatMap((po) => po.receipts.map((receipt) => [receipt.id, receipt])));
  const movements = new Map(inventory.map((m) => [m.id, m]));
  let validMoney = true, noOrphans = true;
  for (const entry of ledger) {
    validMoney &&= Number.isSafeInteger(entry.amount) && entry.amount >= 0 && Object.hasOwn(money, entry.type);
    if (!Object.hasOwn(money, entry.type)) continue;
    const amount = BigInt(entry.amount), key = JSON.stringify([entry.type, entry.reference]);
    money[entry.type] += amount;
    actual.set(key, (actual.get(key) ?? 0n) + amount);
    noOrphans &&= entry.type === "purchase" ? receipts.has(entry.reference) : orderIds.has(entry.reference);
    if (entry.inventoryMovementId) noOrphans &&= movements.has(entry.inventoryMovementId);
  }
  const paid = (type, id) => actual.get(JSON.stringify([type, id])) ?? 0n;
  checks.validMoney = validMoney;
  checks.paymentConservation = orders.every((o) => paid("payment", o.id) === BigInt(o.paidAt ? o.total : 0));
  checks.refundConservation = orders.every((o) => paid("refund", o.id) === BigInt(o.refundedAmount));
  checks.purchaseConservation = [...receipts].every(([id, r]) => paid("purchase", id) === BigInt(r.amount));
  checks.noOrphanLedger = noOrphans;
  checks.expectedSeedMoney = money.payment === BigInt(history) * 1000n && money.refund === 0n && money.purchase === 0n;
  const carts = records("biz_carts");
  checks.onlyExpectedCartMutation = carts.length === 1 && carts[0].id === "load-cart" && carts[0].userId === user.id
    && carts[0].productId === firstProduct.id && carts[0].skuId === firstSku.id && carts[0].quantity === 1 && typeof carts[0].selected === "boolean";
  const commandCount = sql.prepare("SELECT count(*) AS n FROM command_results").get().n;
  checks.onlyCartCommands = sql.prepare("SELECT count(*) AS n FROM command_results WHERE actor_id<>? OR method<>'updateCart'").get(user.id).n === 0;
  const counts = { products: products.length, skus: skus.size, orders: orders.length, orderItems: lines.size,
    inventory: inventory.length, ledger: ledger.length, purchases: purchases.length, carts: carts.length, commands: commandCount };
  const stocks = [...skus].sort(([a], [b]) => a.localeCompare(b)).map(([id, { sku }]) => [id, sku.stock, String(balances.get(id) ?? 0n), String(reservations.get(id) ?? 0n)]);
  const amounts = { orders: String(sum(orders, "total")), refunded: String(sum(orders, "refundedAmount")),
    payment: String(money.payment), refund: String(money.refund), purchase: String(money.purchase), net: String(money.payment - money.refund - money.purchase) };
  console.log(JSON.stringify({ verified: Object.values(checks).every(Boolean), dataset: history, checks,
    meta, counts, stockTotal: String([...skus.values()].reduce((n, { sku }) => n + BigInt(sku.stock), 0n)),
    reservations: String([...reservations.values()].reduce((n, quantity) => n + quantity, 0n)), amounts,
    digests: { stocks: hash(stocks), counts: hash(counts), amounts: hash(amounts), orders: hash(sorted(orders)),
      inventory: hash(sorted(inventory)), ledger: hash(sorted(ledger)), expectedOrders: hash(sorted(expectedOrders)),
      expectedInventory: hash(sorted(expectedInventory)), expectedLedger: hash(sorted(expectedLedger)) },
    scope: "Read-only snapshot after 90% list/points reads and 10% cart-selection writes. Seed payments are synthetic historical bookkeeping, not gateway receipts; no purchase/refund occurs in this workload. Lifecycle concurrency is verified separately." }, null, 2));
  if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
} catch {
  console.log(JSON.stringify({ verified: false, checks, code: "READ_ONLY_LOAD_INVARIANT_VERIFICATION_FAILED" }));
  process.exitCode = 1;
} finally {
  if (sql) {
    try { if (sql.isTransaction) sql.exec("ROLLBACK"); } catch { /* no data writes */ }
    try { sql.close(); } catch { /* fixed failure result already emitted */ }
  }
}
