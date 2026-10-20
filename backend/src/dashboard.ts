import type { DatabaseSync } from "node:sqlite";
import type { Order, Product, Session } from "../../shared/domain/types";
import { queryPage, queryRecord } from "./database";
import { permits } from "./permissions";
import { stockAvailabilityFrom, availableStockSql } from "./stock-availability";

export function dashboard(sql: DatabaseSync, session: Session) {
  const canFinance = permits(session, "finance"),
    canOrders =
      canFinance ||
      permits(session, "warehouse") ||
      permits(session, "support");
  const scalar = (query: string) =>
    (sql.prepare(query).get() as { n: number }).n;
  const sums = { payment: 0n, refund: 0n, purchase: 0n },
    byDay = new Map<string, bigint>();
  if (canFinance)
    for (const row of sql
      .prepare(
        "SELECT amount,json_extract(data,'$.type') AS type,created_at FROM biz_ledger",
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
  const lowStock =
    permits(session, "warehouse") || permits(session, "catalog")
      ? (
          sql
            .prepare(
              `SELECT s.id,s.product_id,s.stock,s.data,coalesce(reservations.reserved,0) AS reserved,${availableStockSql} AS available ${stockAvailabilityFrom} WHERE ${availableStockSql}<=5 ORDER BY ${availableStockSql},s.id LIMIT 100`,
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
  const ranking = canOrders
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
    orders: canOrders ? scalar("SELECT count(*) AS n FROM biz_orders") : null,
    activeProducts: scalar(
      "SELECT count(*) AS n FROM biz_products WHERE active=1",
    ),
    income: canFinance ? String(sums.payment) : null,
    refund: canFinance ? String(sums.refund) : null,
    purchase: canFinance ? String(sums.purchase) : null,
    net: canFinance ? String(sums.payment - sums.refund - sums.purchase) : null,
    tasks: {
      paid: permits(session, "warehouse")
        ? scalar("SELECT count(*) AS n FROM biz_orders WHERE status='paid'")
        : null,
      requested: permits(session, "support")
        ? scalar(
            "SELECT count(*) AS n FROM biz_after_sales WHERE status='requested'",
          )
        : null,
      waiting: permits(session, "support")
        ? scalar(
            "SELECT count(*) AS n FROM biz_conversations WHERE status='waiting'",
          )
        : null,
    },
    trend,
    ranking,
    lowStock,
    recentOrders: canOrders
      ? queryPage<Order>(sql, "orders", { pageSize: 5, sort: "newest" }).items
      : [],
    revision: scalar("SELECT revision AS n FROM storage_meta WHERE id=1"),
  };
}
