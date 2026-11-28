/** Aggregate live reservations by warehouse and SKU before joining the catalog. */
export function stockAvailabilityQuery(scoped = false) {
  return `
  FROM product_skus s
  JOIN biz_products p ON p.key=s.product_id
  LEFT JOIN (
    SELECT json_extract(w.data,'$.skuId') AS sku_id,
      sum(json_extract(w.data,'$.onHand')) AS on_hand,
      sum(json_extract(w.data,'$.onHand') - json_extract(w.data,'$.committed')
        - json_extract(w.data,'$.transferLocked') - coalesce(r.reserved,0)) AS available
    FROM biz_warehouse_stocks w
    JOIN biz_warehouses warehouse
      ON warehouse.key=json_extract(w.data,'$.warehouseId')
        ${scoped ? "" : "AND json_extract(warehouse.data,'$.acceptsOrders')=1"}
    LEFT JOIN (
      SELECT i.sku_id,
        coalesce(json_extract(a.value,'$.warehouseId'),'warehouse-default') AS warehouse_id,
        sum(coalesce(json_extract(a.value,'$.quantity'),i.quantity)) AS reserved
      FROM biz_orders o JOIN order_items i ON i.order_id=o.key
      LEFT JOIN json_each(o.data,'$.allocations') a ON json_extract(a.value,'$.orderItemId')=i.id
      WHERE o.status='pending'
        AND json_extract(o.data,'$.inventoryPolicy')='reserved-v1'
        AND (json_extract(o.data,'$.paymentHold')=1 OR json_extract(o.data,'$.expiresAt')>?)
      GROUP BY i.sku_id,warehouse_id
    ) r ON r.sku_id=json_extract(w.data,'$.skuId') AND r.warehouse_id=warehouse.key
    ${scoped ? "WHERE warehouse.key IN (SELECT value FROM json_each(?))" : ""}
    GROUP BY json_extract(w.data,'$.skuId')
  ) stocks ON stocks.sku_id=s.id`;
}

export const stockAvailabilityFrom = stockAvailabilityQuery();
export const availableStockSql = "coalesce(stocks.available,0)";
