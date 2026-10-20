/** Read-only acceptance snapshots only; never migrates, expires orders, or repairs data. */
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  Database,
  OrderItem,
  Product,
  SKU,
} from "../../shared/domain/types";

export interface StabilityBaseline {
  format: 1;
  historyCount: number;
  historyDigest: string;
  commandResultsCount: number;
  commandResultsDigest: string;
  completedJobsCount: number;
  completedJobsDigest: string;
}
type Row = Record<string, string | number | null>;
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b, "en"))
            .map(([k, v]) => [k, canonical(v)]),
        )
      : value;
const equal = (a: unknown, b: unknown) =>
  digest(canonical(a)) === digest(canonical(b));
const integer = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n);

function snapshot<T>(path: string, action: (sql: DatabaseSync) => T): T {
  if (
    process.env.SHOPMATE_ENV !== "acceptance" ||
    process.env.LOAD_TEST_ALLOWED !== "1"
  )
    throw new Error("EXPLICIT_ISOLATED_ACCEPTANCE_DATASET_REQUIRED");
  const sql = new DatabaseSync(resolve(path), { readOnly: true });
  try {
    sql.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000; BEGIN");
    const isolated = sql
      .prepare(
        "SELECT id,username FROM accounts WHERE role='user' AND username GLOB 'stability_[0-9]*'",
      )
      .all();
    if (
      isolated.length !== 50 ||
      !Array.from({ length: 50 }, (_, i) => i).every((i) =>
        isolated.some(
          (row) =>
            row.id === `stability-${i}` && row.username === `stability_${i}`,
        ),
      ) ||
      !sql
        .prepare(
          "SELECT 1 FROM accounts WHERE role='user' AND username='loaduser'",
        )
        .get()
    )
      throw new Error("ISOLATED_STABILITY_ACCOUNTS_REQUIRED");
    return action(sql);
  } finally {
    if (sql.isTransaction) sql.exec("ROLLBACK");
    sql.close();
  }
}

function baseline(sql: DatabaseSync): StabilityBaseline {
  const history = sql
      .prepare(
        "SELECT key,data FROM biz_orders WHERE key GLOB 'history-*' ORDER BY key",
      )
      .all(),
    commands = sql
      .prepare(
        "SELECT * FROM command_results WHERE method='baseline' AND request_id GLOB 'baseline-*' ORDER BY actor_id,method,request_id",
      )
      .all(),
    jobs = sql
      .prepare("SELECT * FROM job_queue WHERE id GLOB 'baseline-*' ORDER BY id")
      .all();
  if (
    history.length !== 10000 ||
    commands.length !== 10000 ||
    jobs.length !== 10000 ||
    history.some(
      (row, i) => row.key !== `history-${String(i).padStart(6, "0")}`,
    )
  )
    throw new Error("COMPLETE_STABILITY_BASELINE_REQUIRED");
  return {
    format: 1,
    historyCount: history.length,
    historyDigest: digest(history),
    commandResultsCount: commands.length,
    commandResultsDigest: digest(commands),
    completedJobsCount: jobs.length,
    completedJobsDigest: digest(jobs),
  };
}
export function captureStabilityBaseline(path: string) {
  return snapshot(path, baseline);
}

export function verifyStability(path: string, expected: StabilityBaseline) {
  if (
    expected.format !== 1 ||
    expected.historyCount !== 10000 ||
    expected.commandResultsCount !== 10000 ||
    expected.completedJobsCount !== 10000 ||
    ![
      expected.historyDigest,
      expected.commandResultsDigest,
      expected.completedJobsDigest,
    ].every((v) => /^[a-f0-9]{64}$/.test(v))
  )
    throw new Error("INVALID_STABILITY_BASELINE");
  return snapshot(path, (sql) => {
    const checks: Record<string, boolean> = {};
    const current = baseline(sql);
    checks.readOnlySnapshot =
      sql.isTransaction &&
      sql.prepare("PRAGMA query_only").get()!.query_only === 1;
    const integrity = sql.prepare("PRAGMA integrity_check").all();
    checks.integrity =
      integrity.length === 1 && Object.values(integrity[0]!)[0] === "ok";
    checks.foreignKeys =
      sql.prepare("PRAGMA foreign_key_check").all().length === 0;
    checks.historicalOrdersUnchanged =
      current.historyDigest === expected.historyDigest;
    checks.baselineCommandsPreserved =
      current.commandResultsDigest === expected.commandResultsDigest;
    checks.completedJobsPreserved =
      current.completedJobsDigest === expected.completedJobsDigest;
    const records = <T>(table: string): T[] =>
      (
        sql.prepare(`SELECT data FROM ${table} ORDER BY key`).all() as {
          data: string;
        }[]
      ).map((row) => JSON.parse(row.data));
    const products = records<Product>("biz_products"),
      orders = records<Database["orders"][number]>("biz_orders"),
      inventory = records<Database["inventory"][number]>("biz_inventory"),
      ledger = records<Database["ledger"][number]>("biz_ledger"),
      purchases = records<NonNullable<Database["purchaseOrders"]>[number]>(
        "biz_purchase_orders",
      ),
      sales = records<Database["afterSales"][number]>("biz_after_sales");
    const users = new Set(
      sql
        .prepare("SELECT id FROM accounts WHERE role='user'")
        .all()
        .map((row) => String(row.id)),
    );
    const skus = new Map<string, { productId: string; sku: SKU }>(),
      balances = new Map<string, bigint>(),
      reservations = new Map<string, bigint>();
    let validStocks = true,
      validInventory = true,
      validItems = true;
    for (const product of products)
      for (const sku of product.skus) {
        validStocks &&=
          integer(sku.stock) && sku.stock >= 0 && !skus.has(sku.id);
        skus.set(sku.id, { productId: product.id, sku });
      }
    for (const movement of inventory) {
      validInventory &&=
        integer(movement.delta) &&
        skus.get(movement.skuId)?.productId === movement.productId;
      if (integer(movement.delta))
        balances.set(
          movement.skuId,
          (balances.get(movement.skuId) ?? 0n) + BigInt(movement.delta),
        );
    }
    const now = Date.now(),
      items = new Map<string, { orderId: string; item: OrderItem }>();
    for (const order of orders)
      for (const item of order.items) {
        validItems &&=
          !items.has(item.id) &&
          integer(item.quantity) &&
          item.quantity > 0 &&
          integer(item.refundedQuantity) &&
          item.refundedQuantity >= 0 &&
          item.refundedQuantity <= item.quantity &&
          skus.get(item.skuId)?.productId === item.productId;
        items.set(item.id, { orderId: order.id, item });
        if (
          order.status === "pending" &&
          order.inventoryPolicy === "reserved-v1" &&
          Date.parse(order.expiresAt ?? "") > now &&
          integer(item.quantity)
        )
          reservations.set(
            item.skuId,
            (reservations.get(item.skuId) ?? 0n) + BigInt(item.quantity),
          );
      }
    checks.nonnegativeStocks = validStocks;
    checks.perSkuStockEqualsInventoryDeltas =
      validInventory &&
      validStocks &&
      [...skus].every(
        ([id, { sku }]) => BigInt(sku.stock) === (balances.get(id) ?? 0n),
      );
    checks.reservationsWithinStock =
      validStocks &&
      [...reservations].every(
        ([id, quantity]) =>
          quantity >= 0n &&
          skus.has(id) &&
          quantity <= BigInt(skus.get(id)!.sku.stock),
      );
    checks.validOrderItems = validItems;
    const projected = sql.prepare("SELECT * FROM product_skus").all() as Row[],
      projectedItems = sql.prepare("SELECT * FROM order_items").all() as Row[];
    checks.skuProjection =
      projected.length === skus.size &&
      projected.every((row) => {
        const source = skus.get(String(row.id));
        return (
          !!source &&
          row.product_id === source.productId &&
          row.price === source.sku.price &&
          row.stock === source.sku.stock &&
          equal(JSON.parse(String(row.data)), source.sku)
        );
      });
    checks.orderItemProjection =
      projectedItems.length === items.size &&
      projectedItems.every((row) => {
        const source = items.get(String(row.id));
        return (
          !!source &&
          row.order_id === source.orderId &&
          row.product_id === source.item.productId &&
          row.sku_id === source.item.skuId &&
          row.quantity === source.item.quantity &&
          row.total === source.item.total &&
          row.refunded_quantity === source.item.refundedQuantity &&
          equal(JSON.parse(String(row.data)), source.item)
        );
      });
    const orderMap = new Map(orders.map((order) => [order.id, order])),
      movementIds = new Set(inventory.map((m) => m.id));
    const receipts = new Map(
      purchases.flatMap((po) =>
        po.receipts.map((receipt) => [receipt.id, receipt] as const),
      ),
    );
    const money = { payment: 0n, refund: 0n, purchase: 0n },
      amounts = new Map<string, bigint>(),
      counts = new Map<string, number>(),
      refundNotes = new Map<string, { count: number; amount: bigint }>();
    let validMoney = true,
      noOrphanLedger = true;
    const key = (type: string, ref: string) => JSON.stringify([type, ref]);
    for (const entry of ledger) {
      if (
        !integer(entry.amount) ||
        entry.amount < 0 ||
        !Object.hasOwn(money, entry.type)
      ) {
        validMoney = false;
        continue;
      }
      const amount = BigInt(entry.amount),
        ref = key(entry.type, entry.reference);
      money[entry.type] += amount;
      amounts.set(ref, (amounts.get(ref) ?? 0n) + amount);
      counts.set(ref, (counts.get(ref) ?? 0) + 1);
      if (entry.type === "refund") {
        const noteKey = key(entry.reference, entry.note),
          previous = refundNotes.get(noteKey) ?? { count: 0, amount: 0n };
        refundNotes.set(noteKey, {
          count: previous.count + 1,
          amount: previous.amount + amount,
        });
      }
      noOrphanLedger &&=
        entry.type === "purchase"
          ? receipts.has(entry.reference)
          : orderMap.has(entry.reference);
      if (entry.inventoryMovementId)
        noOrphanLedger &&= movementIds.has(entry.inventoryMovementId);
    }
    const amount = (type: string, ref: string) =>
        amounts.get(key(type, ref)) ?? 0n,
      count = (type: string, ref: string) => counts.get(key(type, ref)) ?? 0;
    const refundedSales = sales.filter((sale) => sale.status === "refunded"),
      refundedByOrder = new Map<string, typeof sales>();
    for (const sale of refundedSales)
      refundedByOrder.set(sale.orderId, [
        ...(refundedByOrder.get(sale.orderId) ?? []),
        sale,
      ]);
    checks.validMoney =
      validMoney &&
      orders.every(
        (order) =>
          integer(order.total) &&
          order.total >= 0 &&
          integer(order.refundedAmount) &&
          order.refundedAmount >= 0 &&
          order.refundedAmount <= order.total,
      );
    checks.paymentExactlyOnce =
      checks.validMoney &&
      orders.every(
        (order) =>
          count("payment", order.id) === (order.paidAt ? 1 : 0) &&
          amount("payment", order.id) ===
            BigInt(order.paidAt ? order.total : 0),
      );
    checks.refundExactlyOnce =
      checks.validMoney &&
      orders.every((order) => {
        const refunded = refundedByOrder.get(order.id) ?? [];
        return (
          refunded.every((sale) => {
            const payment = refundNotes.get(
              key(order.id, `模拟售后退款 ${sale.id}`),
            );
            return (
              integer(sale.refundAmount) &&
              sale.refundAmount >= 0 &&
              payment?.count === 1 &&
              payment.amount === BigInt(sale.refundAmount)
            );
          }) &&
          count("refund", order.id) === refunded.length &&
          amount("refund", order.id) === BigInt(order.refundedAmount) &&
          refunded.reduce(
            (sum, sale) => sum + BigInt(sale.refundAmount),
            0n,
          ) === BigInt(order.refundedAmount)
        );
      });
    checks.purchaseExactlyOnce = [...receipts].every(
      ([id, receipt]) =>
        integer(receipt.amount) &&
        count("purchase", id) === 1 &&
        amount("purchase", id) === BigInt(receipt.amount),
    );
    checks.noOrphanLedger = noOrphanLedger;
    const ownedRows = [
      "biz_carts",
      "biz_addresses",
      "biz_notifications",
      "biz_checkout_quotes",
      "biz_conversations",
      "biz_coupon_claims",
      "biz_points_entries",
      "biz_order_requests",
    ];
    checks.noOrphanOwnership =
      orders.every(
        (order) =>
          users.has(order.userId) && order.address.userId === order.userId,
      ) &&
      sales.every(
        (sale) =>
          orderMap.get(sale.orderId)?.userId === sale.userId &&
          users.has(sale.userId),
      ) &&
      ownedRows.every((table) =>
        records<{ userId: string; orderId?: string }>(table).every(
          (row) =>
            users.has(row.userId) &&
            (!row.orderId || orderMap.get(row.orderId)?.userId === row.userId),
        ),
      ) &&
      records<{ userId: string; address: { userId: string } }>(
        "biz_checkout_quotes",
      ).every((quote) => quote.address.userId === quote.userId);
    checks.financeBalance =
      checks.paymentExactlyOnce &&
      checks.refundExactlyOnce &&
      checks.purchaseExactlyOnce &&
      checks.noOrphanLedger;
    const commandCount = Number(
      sql.prepare("SELECT count(*) count FROM command_results").get()!.count,
    );
    checks.commandHistoryRetained =
      commandCount >= expected.commandResultsCount;
    const resultCounts = {
      users: users.size,
      products: products.length,
      skus: skus.size,
      orders: orders.length,
      history: current.historyCount,
      orderItems: items.size,
      inventory: inventory.length,
      ledger: ledger.length,
      refunds: refundedSales.length,
      commandResults: commandCount,
    };
    const finance = {
      payment: String(money.payment),
      refund: String(money.refund),
      purchase: String(money.purchase),
      net: String(money.payment - money.refund - money.purchase),
    };
    return {
      verified: Object.values(checks).every(Boolean),
      checks,
      counts: resultCounts,
      amounts: finance,
      reservations: String(
        [...reservations.values()].reduce((sum, value) => sum + value, 0n),
      ),
      digests: {
        history: current.historyDigest,
        baselineCommands: current.commandResultsDigest,
        completedJobs: current.completedJobsDigest,
        orders: digest(orders),
        inventory: digest(inventory),
        ledger: digest(ledger),
        finance: digest(finance),
      },
    };
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const args = process.argv.slice(2),
      option = (name: string) => {
        const at = args.indexOf(name);
        return at >= 0 ? args[at + 1] : undefined;
      },
      path = option("--database") ?? process.env.DATABASE_PATH;
    if (!path) throw new Error("DATABASE_PATH_REQUIRED");
    if (args.includes("--capture-baseline"))
      console.log(JSON.stringify(captureStabilityBaseline(path)));
    else {
      const baselinePath = option("--baseline");
      if (!baselinePath) throw new Error("BASELINE_PATH_REQUIRED");
      const result = verifyStability(
        path,
        JSON.parse(readFileSync(baselinePath, "utf8")),
      );
      console.log(JSON.stringify(result, null, 2));
      if (!result.verified) process.exitCode = 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    console.log(
      JSON.stringify({
        verified: false,
        code: /^[A-Z_]+$/.test(message)
          ? message
          : "READ_ONLY_STABILITY_VERIFICATION_FAILED",
      }),
    );
    process.exitCode = 1;
  }
}
