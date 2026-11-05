import type { DatabaseSync } from "node:sqlite";

export function reconcile(sql: DatabaseSync) {
  // Return decimal text: both Number and SQLite's 64-bit SUM can overflow a valid history.
  sql.aggregate("reconciliation_sum", {
    start: 0n,
    useBigIntArguments: true,
    step: (total: bigint, value) => total + BigInt(value as bigint | string),
    result: (total: bigint) => String(total),
  });
  sql.exec("BEGIN");
  try {
    const { revision } = sql
      .prepare("SELECT revision FROM storage_meta WHERE id=1")
      .get() as { revision: number };
    // TEXT affinity lets SQLite index the complete join keys of materialized aggregates.
    const issues = sql
      .prepare(
        `
      WITH amounts AS MATERIALIZED (
        SELECT json_extract(data,'$.type') type,CAST(json_extract(data,'$.reference') AS TEXT) reference,
          reconciliation_sum(amount) amount FROM biz_ledger GROUP BY type,reference
      ), differences AS (
        SELECT 'payment' kind,o.key reference,
          CAST(CASE WHEN coalesce(json_extract(o.data,'$.paidAt'),'')<>'' THEN json_extract(o.data,'$.total') ELSE 0 END AS TEXT) expected,
          coalesce(a.amount,'0') actual FROM biz_orders o LEFT JOIN amounts a ON a.type='payment' AND a.reference=o.key
        UNION ALL
        SELECT 'refund',o.key,CAST(json_extract(o.data,'$.refundedAmount') AS TEXT),coalesce(a.amount,'0')
          FROM biz_orders o LEFT JOIN amounts a ON a.type='refund' AND a.reference=o.key
        UNION ALL
        SELECT 'purchase',json_extract(r.value,'$.id'),CAST(json_extract(r.value,'$.amount') AS TEXT),coalesce(a.amount,'0')
          FROM biz_purchase_orders p,json_each(p.data,'$.receipts') r
          LEFT JOIN amounts a ON a.type='purchase' AND a.reference=json_extract(r.value,'$.id')
        UNION ALL
        SELECT 'orphan-ledger',l.key,'0',CAST(l.amount AS TEXT) FROM biz_ledger l
          WHERE json_extract(l.data,'$.type') IN ('payment','refund')
          AND NOT EXISTS(SELECT 1 FROM biz_orders o WHERE o.key=json_extract(l.data,'$.reference'))
        UNION ALL
        SELECT 'orphan-inventory',l.key,'0',CAST(l.amount AS TEXT) FROM biz_ledger l
          WHERE json_extract(l.data,'$.type')='purchase' AND coalesce(json_extract(l.data,'$.inventoryMovementId'),'')<>''
          AND NOT EXISTS(SELECT 1 FROM biz_inventory i WHERE i.key=json_extract(l.data,'$.inventoryMovementId'))
        UNION ALL
        SELECT 'stock-ledger',s.id,CAST(s.stock AS TEXT),coalesce(i.balance,'0') FROM product_skus s
          LEFT JOIN (SELECT CAST(json_extract(data,'$.skuId') AS TEXT) sku,reconciliation_sum(json_extract(data,'$.delta')) balance
            FROM biz_inventory GROUP BY sku) i ON i.sku=s.id
      ) SELECT kind,reference,expected,actual FROM differences WHERE expected<>actual ORDER BY kind,reference
    `,
      )
      .all() as {
      kind: string;
      reference: string;
      expected: string;
      actual: string;
    }[];
    const sums = { payment: 0n, refund: 0n, purchase: 0n };
    for (const row of sql
      .prepare(
        "SELECT json_extract(data,'$.type') type,reconciliation_sum(amount) amount FROM biz_ledger GROUP BY type",
      )
      .all() as { type: keyof typeof sums; amount: string }[])
      sums[row.type] = BigInt(row.amount);
    sql.exec("COMMIT");
    return {
      balanced: issues.length === 0,
      issues,
      revision,
      checkedAt: new Date().toISOString(),
      totals: {
        income: String(sums.payment),
        refund: String(sums.refund),
        purchase: String(sums.purchase),
        net: String(sums.payment - sums.refund - sums.purchase),
      },
    };
  } catch (error) {
    sql.exec("ROLLBACK");
    throw error;
  }
}
