import type { DatabaseSync } from "node:sqlite";
import type {
  Order,
  Product,
  Session,
  Settings,
} from "../../shared/domain/types";
import { queryPage, queryRecord, readDatabase } from "./database";
import { permits, projectOrderForStaff } from "./permissions";
import { shopMode } from "./production/config";
import { stockAvailabilityFrom, availableStockSql } from "./stock-availability";
import { taskQueues, taskWaitWindow } from "./task-wait";
import { releaseSnapshot, warehouseOrderFilter } from "./storage";
import { pendingStock, warehouseScope } from "./warehouse-stock";

export function dashboard(sql: DatabaseSync, session: Session) {
  const canFinance = permits(session, "finance"),
    canOrders =
      canFinance ||
      permits(session, "warehouse") ||
      permits(session, "support");
  const scalar = (query: string) =>
    (sql.prepare(query).get() as { n: number }).n;
  const time = Date.now();
  const settings = queryRecord<Settings>(sql, "settings", "singleton");
  const warehouseIds = warehouseScope(sql, session);
  const recent = canOrders
    ? queryPage<Order>(sql, "orders", {
        pageSize: 5,
        sort: "newest",
        warehouseIds,
      })
    : null;
  function queueSummary(queue: (typeof taskQueues)[keyof typeof taskQueues]) {
    if (!permits(session, queue.permission)) return null;
    const window = taskWaitWindow(queue.minutesKey, settings, time);
    const scoped = warehouseIds && queue.table === "biz_orders";
    const scope = JSON.stringify(warehouseIds ?? []);
    return sql
      .prepare(
        `SELECT count(*) AS total, min(${queue.since}) AS oldest,
          count(CASE WHEN ${queue.since} <= ? THEN 1 END) AS overdue,
          count(CASE WHEN ${queue.since} > ? AND ${queue.since} <= ? THEN 1 END) AS soon
        FROM ${queue.table} WHERE status=?${scoped ? ` AND ${warehouseOrderFilter("data")}` : ""}`,
      )
      .get(
        window.overdue,
        window.overdue,
        window.soon,
        queue.status,
        ...(scoped ? [scope, scope] : []),
      ) as {
      total: number;
      oldest: string | null;
      overdue: number;
      soon: number;
    };
  }
  const queues = {
    paid: queueSummary(taskQueues.orders),
    requested: queueSummary(taskQueues.afterSales),
    waiting: queueSummary(taskQueues.conversations),
  };
  const sums = { payment: 0n, refund: 0n, purchase: 0n },
    byDay = new Map<string, bigint>();
  if (canFinance)
    for (const row of sql
      .prepare(
        `SELECT amount,json_extract(data,'$.type') AS type,created_at FROM biz_ledger${shopMode() === "production" ? " WHERE json_extract(data,'$.transactionMode')='production'" : ""}`,
      )
      .iterate() as Iterable<{
      amount: number;
      type: keyof typeof sums;
      created_at: string;
    }>) {
      const amount = BigInt(row.amount);
      sums[row.type] += amount;
      if (row.type === "payment") {
        const day = new Date(Date.parse(row.created_at) + 8 * 3600000)
          .toISOString()
          .slice(0, 10);
        byDay.set(day, (byDay.get(day) ?? 0n) + amount);
      }
    }
  const trend = canFinance
    ? Array.from({ length: 7 }, (_, i) => {
        const day = new Date(Date.now() + 8 * 3600000 - (6 - i) * 86400000)
          .toISOString()
          .slice(0, 10);
        return {
          label: `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`,
          total: String(byDay.get(day) ?? 0n),
        };
      })
    : [];
  const lowStock = warehouseIds
    ? scopedWarehouseStock(sql, warehouseIds)
    : permits(session, "warehouse") || permits(session, "catalog")
      ? (
          sql
            .prepare(
              `SELECT s.id,s.product_id,s.stock,s.data,coalesce(stocks.reserved,0) AS reserved,${availableStockSql} AS available ${stockAvailabilityFrom} WHERE ${availableStockSql}<=5 ORDER BY ${availableStockSql},s.id LIMIT 100`,
            )
            .all(new Date().toISOString()) as {
            id: string;
            product_id: string;
            stock: number;
            data: string;
            reserved: number;
            available: number;
          }[]
        ).map((s) => {
          const product = queryRecord<Product>(sql, "products", s.product_id)!;
          return {
            productId: product.id,
            name: product.name,
            skuId: s.id,
            skuName: JSON.parse(s.data).name,
            stock: s.stock,
            reserved: s.reserved,
            available: s.available,
          };
        })
      : [];
  const ranking =
    canOrders && !warehouseIds
      ? (
          sql
            .prepare(
              "SELECT i.product_id,sum(i.quantity-i.refunded_quantity) AS count FROM order_items i JOIN biz_orders o ON o.key=i.order_id WHERE o.status IN ('paid','shipped','completed','refunded') GROUP BY i.product_id HAVING count>0 ORDER BY count DESC,i.product_id LIMIT 4",
            )
            .all() as { product_id: string; count: number }[]
        ).map((r) => {
          const p = queryRecord<Product>(sql, "products", r.product_id);
          return {
            id: r.product_id,
            name: p?.name ?? "历史商品",
            images: p?.images ?? [],
            count: r.count,
          };
        })
      : [];
  return {
    orders: recent?.total ?? null,
    activeProducts: scalar(
      "SELECT count(*) AS n FROM biz_products WHERE active=1",
    ),
    income: canFinance ? String(sums.payment) : null,
    refund: canFinance ? String(sums.refund) : null,
    purchase: canFinance ? String(sums.purchase) : null,
    net: canFinance ? String(sums.payment - sums.refund - sums.purchase) : null,
    tasks: {
      paid: queues.paid?.total ?? null,
      requested: queues.requested?.total ?? null,
      waiting: queues.waiting?.total ?? null,
    },
    queues,
    trend,
    ranking,
    lowStock,
    recentOrders:
      recent?.items.map((order) =>
        projectOrderForStaff(order, session, warehouseIds),
      ) ?? [],
    revision: scalar("SELECT revision AS n FROM storage_meta WHERE id=1"),
  };
}

function scopedWarehouseStock(sql: DatabaseSync, warehouseIds: string[]) {
  const db = readDatabase(sql, { pendingOnly: true });
  try {
    const pending = pendingStock(db);
    return db
      .warehouseStocks!.filter((row) => warehouseIds.includes(row.warehouseId))
      .map((row) => {
        const product = db.products.find(
          (entry) => entry.id === row.productId,
        )!;
        const sku = product.skus.find((entry) => entry.id === row.skuId)!;
        const reserved = pending.get(row.id) ?? 0;
        return {
          productId: product.id,
          name: product.name,
          skuId: sku.id,
          skuName: sku.name,
          stock: row.onHand,
          reserved,
          available: row.onHand - row.committed - row.transferLocked - reserved,
        };
      })
      .filter((row) => row.available <= 5)
      .sort((a, b) => a.available - b.available)
      .slice(0, 100);
  } finally {
    releaseSnapshot(db);
  }
}
