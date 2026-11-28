import type {
  Address,
  Database,
  Order,
  OrderItem,
  Session,
} from "../../shared/domain/types";
import {
  defaultWarehouseId,
  type AllocationLine,
  type Warehouse,
  type WarehouseStock,
} from "../../shared/domain/warehouses";
import {
  addressProvince,
  canonicalProvince,
} from "../../shared/domain/delivery-province";
import { now, requireThat } from "./repository";
import { HttpError } from "./errors";
import type { DatabaseSync } from "node:sqlite";

export const defaultWarehouse = (): Warehouse => ({
  id: defaultWarehouseId,
  name: "默认仓",
  priority: 0,
  provinces: [],
  acceptsOrders: true,
  version: 1,
});

export const stockKey = (warehouseId: string, skuId: string) =>
  JSON.stringify([warehouseId, skuId]);

export function permittedWarehouseIds(db: Database, session: Session) {
  if (session.staffRole === "owner")
    return db.warehouses!.map((warehouse) => warehouse.id);
  if (session.staffRole !== "warehouse") return [];
  return (
    db.warehouseAssignments!.find((entry) => entry.id === session.id)
      ?.warehouseIds ?? [defaultWarehouseId]
  );
}

export function warehouseScope(sql: DatabaseSync, session: Session | null) {
  if (session?.staffRole !== "warehouse") return undefined;
  const row = sql
    .prepare("SELECT data FROM biz_warehouse_assignments WHERE key=?")
    .get(session.id);
  return row
    ? (JSON.parse(String(row.data)).warehouseIds as string[])
    : [defaultWarehouseId];
}

export function includesWarehouseOrder(order: Order, warehouseIds: string[]) {
  return order.allocations
    ? order.allocations.some((allocation) =>
        warehouseIds.includes(allocation.warehouseId),
      )
    : warehouseIds.includes(defaultWarehouseId);
}

export function requireWarehouse(
  db: Database,
  session: Session,
  warehouseId: string,
) {
  const warehouse = db.warehouses!.find((entry) => entry.id === warehouseId);
  requireThat(warehouse, "仓库不存在");
  if (!permittedWarehouseIds(db, session).includes(warehouseId))
    throw new HttpError(403, "当前员工没有此仓库的操作权限");
  return warehouse;
}

export function stockRow(
  db: Database,
  warehouseId: string,
  productId: string,
  skuId: string,
): WarehouseStock {
  const id = stockKey(warehouseId, skuId);
  const rows = (db.warehouseStocks ??= []);
  const row = rows.find((entry) => entry.id === id);
  if (row) return row;
  const entry = {
    id,
    warehouseId,
    productId,
    skuId,
    onHand: 0,
    committed: 0,
    transferLocked: 0,
    defective: 0,
  };
  rows.push(entry);
  return entry;
}

export function pendingStock(
  db: Database,
  excludeOrderId?: string,
  at = now(),
) {
  const reserved = new Map<string, number>();
  for (const order of db.orders) {
    if (
      order.id === excludeOrderId ||
      order.status !== "pending" ||
      order.inventoryPolicy !== "reserved-v1" ||
      (!order.paymentHold && (!order.expiresAt || order.expiresAt <= at))
    )
      continue;
    const items = new Map(order.items.map((item) => [item.id, item.skuId]));
    const allocations =
      order.allocations ??
      order.items.map((item) => ({
        orderItemId: item.id,
        warehouseId: defaultWarehouseId,
        quantity: item.quantity,
      }));
    for (const allocation of allocations) {
      const key = stockKey(
        allocation.warehouseId,
        items.get(allocation.orderItemId)!,
      );
      reserved.set(key, (reserved.get(key) ?? 0) + allocation.quantity);
    }
  }
  return reserved;
}

export function saleWarehouses(
  db: Database,
  address?: Pick<Address, "region" | "province">,
) {
  const province = address ? canonicalProvince(addressProvince(address)) : "";
  return db
    .warehouses!.filter(
      (warehouse) =>
        warehouse.acceptsOrders &&
        (!address ||
          !warehouse.provinces.length ||
          warehouse.provinces.includes(province)),
    )
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}

export function warehouseAvailability(
  db: Database,
  excludeOrderId?: string,
  address?: Pick<Address, "region" | "province">,
) {
  const pending = pendingStock(db, excludeOrderId);
  const eligible = new Set(
    saleWarehouses(db, address).map((warehouse) => warehouse.id),
  );
  return new Map(
    db
      .warehouseStocks!.filter((stock) => eligible.has(stock.warehouseId))
      .map((stock) => [
        stock.id,
        stock.onHand -
          stock.committed -
          stock.transferLocked -
          (pending.get(stock.id) ?? 0),
      ]),
  );
}

export function allocateOrder(
  db: Database,
  items: OrderItem[],
  address: Address,
): AllocationLine[] {
  const warehouses = saleWarehouses(db, address);
  const available = warehouseAvailability(db, undefined, address);
  const required = new Map<string, number>();
  for (const item of items)
    required.set(item.skuId, (required.get(item.skuId) ?? 0) + item.quantity);
  const single = warehouses.find((warehouse) =>
    [...required].every(
      ([skuId, quantity]) =>
        (available.get(stockKey(warehouse.id, skuId)) ?? 0) >= quantity,
    ),
  );
  const candidates = single ? [single] : warehouses;
  const result: AllocationLine[] = [];
  for (const item of items) {
    let remaining = item.quantity;
    for (const warehouse of candidates) {
      const key = stockKey(warehouse.id, item.skuId);
      const quantity = Math.min(remaining, available.get(key) ?? 0);
      if (quantity <= 0) continue;
      result.push({
        orderItemId: item.id,
        warehouseId: warehouse.id,
        quantity,
      });
      available.set(key, available.get(key)! - quantity);
      remaining -= quantity;
      if (remaining === 0) break;
    }
    requireThat(
      remaining === 0,
      `${item.name} ${item.skuName} 在该地址的可配送库存不足`,
    );
  }
  return result;
}

export function commitWarehouseStock(db: Database, order: Order) {
  const reservations = payableWarehouseStock(db, order);
  requireThat(reservations, "订单分仓库存已变化");
  for (const [row, quantity] of reservations) row.committed += quantity;
}

export function payableWarehouseStock(db: Database, order: Order) {
  const pending = pendingStock(db, order.id);
  const items = new Map(order.items.map((item) => [item.id, item]));
  const quantities = new Map<WarehouseStock, number>();
  for (const allocation of order.allocations!) {
    const item = items.get(allocation.orderItemId)!;
    const row = stockRow(
      db,
      allocation.warehouseId,
      item.productId,
      item.skuId,
    );
    quantities.set(row, (quantities.get(row) ?? 0) + allocation.quantity);
  }
  return [...quantities].every(
    ([row, quantity]) =>
      row.onHand -
        row.committed -
        row.transferLocked -
        (pending.get(row.id) ?? 0) >=
      quantity,
  )
    ? quantities
    : null;
}
