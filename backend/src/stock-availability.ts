/** Aggregate live reservations once before joining SKUs; bind the current ISO time. */
export const stockAvailabilityFrom = `
  FROM product_skus s
  JOIN biz_products p ON p.key=s.product_id
  LEFT JOIN (
    SELECT i.product_id,i.sku_id,sum(i.quantity) AS reserved
    FROM biz_orders o JOIN order_items i ON i.order_id=o.key
    WHERE o.status='pending'
      AND json_extract(o.data,'$.inventoryPolicy')='reserved-v1'
      AND json_extract(o.data,'$.expiresAt')>?
    GROUP BY i.product_id,i.sku_id
  ) reservations ON reservations.product_id=s.product_id AND reservations.sku_id=s.id`;

export const availableStockSql = "s.stock-coalesce(reservations.reserved,0)";
