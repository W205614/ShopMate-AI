import type {
  AfterSale,
  AfterSaleLine,
  Database,
  Order,
  Session,
} from "../../shared/domain/types";
import type { OrderAllocation, Parcel } from "../../shared/domain/warehouses";
import { activeAfterSale, syncOrderPoints } from "./commerce-rules";
import { id, integer, move, now, requireThat } from "./repository";
import {
  pendingStock,
  requireWarehouse,
  saleWarehouses,
  stockRow,
} from "./warehouse-stock";

export function openAllocation(order: Order, allocation: OrderAllocation) {
  return allocation.quantity - allocation.shipped - allocation.cancelled;
}

export function pendingSaleQuantity(
  db: Database,
  order: Order,
  allocationId: string,
) {
  return db.afterSales
    .filter((sale) => sale.orderId === order.id && activeAfterSale(sale.status))
    .flatMap((sale) => sale.lines.flatMap((line) => line.fulfillments ?? []))
    .filter((line) => line.allocationId === allocationId && !line.parcelId)
    .reduce((quantity, line) => quantity + line.quantity, 0);
}

export function claimFulfillments(
  db: Database,
  order: Order,
  orderItemId: string,
  quantity: number,
): NonNullable<AfterSaleLine["fulfillments"]> {
  const claimed = db.afterSales
    .filter(
      (sale) =>
        sale.orderId === order.id &&
        (activeAfterSale(sale.status) || sale.status === "refunded"),
    )
    .flatMap((sale) => sale.lines.flatMap((line) => line.fulfillments ?? []));
  const result: NonNullable<AfterSaleLine["fulfillments"]> = [];
  let remaining = quantity;
  const allocations = order.allocations!.filter(
    (entry) => entry.orderItemId === orderItemId,
  );
  for (const allocation of allocations) {
    const units = Math.min(remaining, openAllocation(order, allocation));
    if (units > 0) {
      result.push({ allocationId: allocation.id, quantity: units });
      remaining -= units;
    }
  }
  for (const allocation of allocations) {
    const add = (available: number, parcelId?: string) => {
      const units = Math.min(remaining, available);
      if (units <= 0) return;
      result.push({
        allocationId: allocation.id,
        ...(parcelId ? { parcelId } : {}),
        quantity: units,
      });
      remaining -= units;
    };
    for (const parcel of order.parcels!) {
      const line = parcel.lines.find(
        (entry) => entry.allocationId === allocation.id,
      );
      if (!line) continue;
      const alreadyClaimed = claimed
        .filter(
          (entry) =>
            entry.allocationId === allocation.id &&
            entry.parcelId === parcel.id,
        )
        .reduce((sum, entry) => sum + entry.quantity, 0);
      add(line.quantity - alreadyClaimed, parcel.id);
    }
  }
  requireThat(remaining === 0, "售后数量超过待发货与已发包裹剩余数量");
  return result;
}

export function updateFulfillmentStatus(db: Database, order: Order) {
  if (
    !order.allocations ||
    !order.parcels?.length ||
    order.status === "refunded"
  )
    return;
  const hasPending = order.allocations.some(
    (allocation) => openAllocation(order, allocation) > 0,
  );
  order.status = hasPending ? "paid" : "shipped";
  if (!hasPending && order.parcels.every((parcel) => parcel.receivedAt)) {
    order.status = "completed";
    order.completedAt ??= now();
    syncOrderPoints(db, order);
  }
}

export function dispatchParcel(
  db: Database,
  order: Order,
  actor: Session,
  input: Pick<Parcel, "warehouseId" | "carrier" | "tracking" | "lines">,
) {
  requireWarehouse(db, actor, input.warehouseId);
  requireThat(
    order.allocations && order.parcels && order.status === "paid",
    "订单没有可发货商品",
  );
  requireThat(
    input.lines.length > 0 &&
      new Set(input.lines.map((line) => line.allocationId)).size ===
        input.lines.length,
    "请选择不重复的发货明细",
  );
  requireThat(
    !order.parcels.some(
      (parcel) =>
        parcel.carrier === input.carrier && parcel.tracking === input.tracking,
    ),
    "该运单已绑定订单包裹",
  );
  const parcel: Parcel = {
    ...input,
    id: id("parcel-"),
    shippedAt: now(),
  };
  for (const line of parcel.lines) {
    const allocation = order.allocations.find(
      (entry) => entry.id === line.allocationId,
    );
    requireThat(
      allocation?.warehouseId === parcel.warehouseId &&
        integer(line.quantity, 1) &&
        line.quantity <=
          openAllocation(order, allocation) -
            pendingSaleQuantity(db, order, allocation.id),
      "商品不属于此仓，或可发数量不足（含售后锁定）",
    );
    const item = order.items.find(
      (entry) => entry.id === allocation.orderItemId,
    )!;
    const row = stockRow(db, parcel.warehouseId, item.productId, item.skuId);
    requireThat(row.committed >= line.quantity, "待发货库存不一致");
    row.committed -= line.quantity;
    move(
      db,
      item.productId,
      item.skuId,
      -line.quantity,
      `订单包裹出库 ${parcel.id}`,
      parcel.warehouseId,
    );
    allocation.shipped += line.quantity;
  }
  order.parcels.push(parcel);
  order.shippedAt ??= parcel.shippedAt;
  order.carrier ??= parcel.carrier;
  order.tracking ??= parcel.tracking;
  order.events.push({
    at: parcel.shippedAt,
    actor: "admin",
    action: "shipped",
    note: `${parcel.carrier} ${parcel.tracking}`,
  });
  updateFulfillmentStatus(db, order);
  return parcel;
}

export function moveAllocation(
  db: Database,
  order: Order,
  actor: Session,
  allocationId: string,
  toWarehouseId: string,
  quantity: number,
) {
  const allocation = order.allocations?.find(
    (entry) => entry.id === allocationId,
  );
  requireThat(order.status === "paid" && allocation, "订单没有可改派商品");
  requireWarehouse(db, actor, allocation.warehouseId);
  requireWarehouse(db, actor, toWarehouseId);
  requireThat(
    toWarehouseId !== allocation.warehouseId &&
      saleWarehouses(db, order.address).some(
        (warehouse) => warehouse.id === toWarehouseId,
      ),
    "目标仓须有权限且可配送至订单地址",
  );
  requireThat(
    integer(quantity, 1) &&
      quantity <=
        openAllocation(order, allocation) -
          pendingSaleQuantity(db, order, allocation.id),
    "改派数量超过当前可改派数量",
  );
  const item = order.items.find(
    (entry) => entry.id === allocation.orderItemId,
  )!;
  const origin = stockRow(
    db,
    allocation.warehouseId,
    item.productId,
    item.skuId,
  );
  const destination = stockRow(db, toWarehouseId, item.productId, item.skuId);
  requireThat(
    destination.onHand -
      destination.committed -
      destination.transferLocked -
      (pendingStock(db).get(destination.id) ?? 0) >=
      quantity,
    "目标仓库存不足",
  );
  requireThat(origin.committed >= quantity, "来源仓待发库存不一致");
  origin.committed -= quantity;
  destination.committed += quantity;
  if (allocation.quantity === quantity) allocation.warehouseId = toWarehouseId;
  else {
    allocation.quantity -= quantity;
    order.allocations!.push({
      id: id("allocation-"),
      orderItemId: item.id,
      warehouseId: toWarehouseId,
      quantity,
      shipped: 0,
      cancelled: 0,
    });
  }
  order.events.push({
    at: now(),
    actor: "admin",
    action: "warehouseReassigned",
  });
}

export function releaseRefundedAllocation(
  db: Database,
  order: Order,
  sale: AfterSale,
) {
  for (const line of sale.lines) {
    const item = order.items.find((entry) => entry.id === line.orderItemId)!;
    for (const fulfillment of line.fulfillments ?? []) {
      if (fulfillment.parcelId) continue;
      const allocation = order.allocations!.find(
        (entry) => entry.id === fulfillment.allocationId,
      )!;
      const row = stockRow(
        db,
        allocation.warehouseId,
        item.productId,
        item.skuId,
      );
      requireThat(
        row.committed >= fulfillment.quantity &&
          openAllocation(order, allocation) >= fulfillment.quantity,
        "退款数量超过仓库待发数量",
      );
      row.committed -= fulfillment.quantity;
      allocation.cancelled += fulfillment.quantity;
    }
  }
}
