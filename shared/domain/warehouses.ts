export const defaultWarehouseId = "warehouse-default";

export interface Warehouse {
  id: string;
  name: string;
  priority: number;
  provinces: string[];
  acceptsOrders: boolean;
  returnAddress?: string;
  version: number;
}

export interface WarehouseStock {
  id: string;
  warehouseId: string;
  productId: string;
  skuId: string;
  onHand: number;
  committed: number;
  transferLocked: number;
  defective: number;
}

export interface WarehouseAssignment {
  id: string;
  warehouseIds: string[];
}

export interface AllocationLine {
  orderItemId: string;
  warehouseId: string;
  quantity: number;
}

export interface OrderAllocation extends AllocationLine {
  id: string;
  shipped: number;
  cancelled: number;
}

export interface Parcel {
  id: string;
  warehouseId: string;
  lines: { allocationId: string; quantity: number }[];
  carrier: string;
  tracking: string;
  shippedAt: string;
  receivedAt?: string;
}

export interface ReturnParcel {
  id: string;
  warehouseId: string;
  address?: string;
  carrier?: string;
  tracking?: string;
  receivedAt?: string;
}

export interface StockTransfer {
  id: string;
  fromWarehouseId: string;
  toWarehouseId: string;
  lines: {
    productId: string;
    skuId: string;
    quantity: number;
    received: number;
    discrepancy: number;
    returned: number;
  }[];
  status: "locked" | "inTransit" | "received" | "cancelled";
  createdAt: string;
  note?: string;
  version: number;
}
