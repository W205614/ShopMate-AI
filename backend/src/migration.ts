import type { Database } from "../../shared/domain/types";
import { defaultWarehouseId } from "../../shared/domain/warehouses";
import { defaultWarehouse, stockRow } from "./warehouse-stock";

export const businessVersion = 6;

function migrateWarehouses(db: Database, at: string) {
  db.warehouses = [defaultWarehouse()];
  db.warehouseStocks = [];
  db.warehouseAssignments = [];
  db.stockTransfers = [];
  const currentSkus = new Map(
    db.products.flatMap((product) =>
      product.skus.map((sku) => {
        const row = stockRow(db, defaultWarehouseId, product.id, sku.id);
        row.onHand = sku.stock;
        return [sku.id, sku] as const;
      }),
    ),
  );
  const physicalDifference = new Map<
    string,
    { productId: string; quantity: number }
  >();
  for (const order of db.orders) {
    if (
      order.status !== "paid" &&
      (order.status !== "pending" || order.inventoryPolicy !== "reserved-v1")
    )
      continue;
    order.allocations = order.items.map((item, index) => ({
      id: `${order.id}-allocation-${index + 1}`,
      orderItemId: item.id,
      warehouseId: defaultWarehouseId,
      quantity: item.quantity,
      shipped: 0,
      cancelled: item.refundedQuantity,
    }));
    order.parcels = [];
    if (order.status !== "paid") continue;
    for (const item of order.items) {
      const quantity = item.quantity - item.refundedQuantity;
      if (!quantity) continue;
      const sku = currentSkus.get(item.skuId);
      if (!sku) throw new Error("待发货订单引用了不存在的规格");
      const row = stockRow(db, defaultWarehouseId, item.productId, item.skuId);
      row.onHand += quantity;
      row.committed += quantity;
      sku.stock += quantity;
      const previous = physicalDifference.get(item.skuId)?.quantity ?? 0;
      physicalDifference.set(item.skuId, {
        productId: item.productId,
        quantity: previous + quantity,
      });
    }
  }
  for (const [skuId, difference] of physicalDifference)
    db.inventory.unshift({
      id: `warehouse-v6-opening-${skuId}`,
      productId: difference.productId,
      skuId,
      warehouseId: defaultWarehouseId,
      delta: difference.quantity,
      reason: "多仓迁移：旧版付款已扣账、实物尚未出库",
      createdAt: at,
    });
  const paidOrders = new Map(
    db.orders
      .filter((order) => order.status === "paid")
      .map((order) => [order.id, order]),
  );
  for (const sale of db.afterSales) {
    const order = paidOrders.get(sale.orderId);
    if (
      !order ||
      sale.requiresReturn ||
      ["cancelled", "rejected", "refunded"].includes(sale.status)
    )
      continue;
    for (const line of sale.lines) {
      const allocation = order.allocations!.find(
        (entry) => entry.orderItemId === line.orderItemId,
      );
      if (!allocation) throw new Error("待退款售后引用了不存在的订单条目");
      line.fulfillments = [
        { allocationId: allocation.id, quantity: line.quantity },
      ];
    }
  }
  for (const purchase of db.purchaseOrders ?? [])
    purchase.warehouseId = defaultWarehouseId;
  for (const inspection of db.returnInspections ?? []) {
    inspection.warehouseId = defaultWarehouseId;
    if (inspection.status === "inspected")
      stockRow(
        db,
        defaultWarehouseId,
        inspection.productId,
        inspection.skuId,
      ).defective += inspection.defective - inspection.disposed;
  }
  db.version = businessVersion;
}

/** Upgrade JSON business state without replaying stock movements or financial entries. */
export function migrateDatabase(
  db: Database,
  at = new Date().toISOString(),
): boolean {
  if (db.version > businessVersion)
    throw new Error("数据库版本高于当前程序支持范围，请恢复匹配版本的程序");
  if (db.version === businessVersion) return false;
  if (db.version >= 4) {
    migrateWarehouses(db, at);
    return true;
  }
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
  migrateWarehouses(db, at);
  return true;
}
