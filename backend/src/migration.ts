import type { Database } from "../../shared/domain/types";

/** Upgrade JSON business state without replaying stock movements or financial entries. */
export function migrateDatabase(
  db: Database,
  at = new Date().toISOString(),
): boolean {
  if (db.version > 4)
    throw new Error("数据库版本高于当前程序支持范围，请恢复匹配版本的程序");
  if (db.version === 4) return false;
  if (db.version < 2) {
    db.coupons ??= [];
    db.couponClaims ??= [];
    db.reviews ??= [];
    db.checkoutQuotes ??= [];
    db.orderRequests ??= [];
    for (const order of db.orders) {
      order.subtotal ??= order.items.reduce(
        (sum, i) => sum + i.price * i.quantity,
        0,
      );
      order.discount ??= Math.max(0, order.subtotal - order.total);
      order.refundedAmount ??= order.status === "refunded" ? order.total : 0;
      order.events ??= [];
      if (!order.events.length) {
        order.events.push({
          at: order.createdAt,
          actor: "system",
          action: "created",
        });
        if (order.paidAt)
          order.events.push({
            at: order.paidAt,
            actor: "system",
            action: "paid",
          });
        if (order.shippedAt)
          order.events.push({
            at: order.shippedAt,
            actor: "system",
            action: "shipped",
          });
      }
      if (order.status === "pending")
        order.expiresAt ??= new Date(Date.parse(at) + 1800000).toISOString();
      for (const [index, item] of order.items.entries()) {
        item.id ??= `${order.id}-line-${index + 1}`;
        item.discount ??= 0;
        item.total ??= item.price * item.quantity - item.discount;
        item.refundedQuantity ??=
          order.status === "refunded" ? item.quantity : 0;
      }
    }
    for (const sale of db.afterSales) {
      const order = db.orders.find((o) => o.id === sale.orderId);
      sale.lines ??= (order?.items ?? []).map((i) => ({
        orderItemId: i.id,
        quantity: i.quantity,
        amount: i.total,
      }));
      sale.refundAmount ??= order?.total ?? 0;
      sale.events ??= [
        { at: sale.createdAt, actor: "system", action: "requested" },
      ];
      if (sale.status === "refunded" && order) {
        order.refundedAmount = order.total;
        for (const item of order.items) item.refundedQuantity = item.quantity;
      }
    }
    for (const uid of new Set(db.addresses.map((a) => a.userId))) {
      const own = db.addresses.filter((a) => a.userId === uid),
        chosen = own.find((a) => a.isDefault) ?? own[0];
      for (const address of own) address.isDefault = address === chosen;
    }
  }
  db.inventoryRequests ??= [];
  db.shippingRules ??= [];
  db.promotions ??= [];
  db.pointsEntries ??= [];
  db.suppliers ??= [];
  db.purchaseOrders ??= [];
  db.returnInspections ??= [];
  db.notifications ??= [];
  db.auditEntries ??= [];
  // Missing policy fields intentionally remain absent: historical orders keep legacy rules.
  db.version = 4;
  return true;
}
