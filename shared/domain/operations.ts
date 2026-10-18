export type StaffRole =
  "owner" | "operations" | "warehouse" | "support" | "finance";
export interface ShippingRule {
  id: string;
  name: string;
  province: string;
  enabled: boolean;
  fee: number;
  freeAbove: number;
  version: number;
}
export interface Promotion {
  id: string;
  name: string;
  threshold: number;
  discount: number;
  startsAt: string;
  endsAt: string;
  active: boolean;
  version: number;
}
export interface PointsEntry {
  id: string;
  userId: string;
  orderId: string;
  delta: number;
  reason: string;
  createdAt: string;
}
export interface Supplier {
  id: string;
  name: string;
  contact: string;
  active: boolean;
  version: number;
}
export interface PurchaseLine {
  productId: string;
  skuId: string;
  quantity: number;
  unitCost: number;
  received: number;
}
export interface PurchaseReceipt {
  id: string;
  createdAt: string;
  lines: { skuId: string; quantity: number }[];
  amount: number;
  movementIds: string[];
}
export interface PurchaseOrder {
  id: string;
  supplierId: string;
  status: "draft" | "ordered" | "partial" | "received" | "cancelled";
  lines: PurchaseLine[];
  receipts: PurchaseReceipt[];
  createdAt: string;
  version: number;
}
export interface ReturnInspection {
  id: string;
  afterSaleId: string;
  orderItemId: string;
  productId: string;
  skuId: string;
  quantity: number;
  good: number;
  defective: number;
  disposed: number;
  status: "pending" | "inspected";
  note: string;
  createdAt: string;
  inspectedAt?: string;
  version: number;
}
export interface Notification {
  id: string;
  userId: string;
  orderId?: string;
  text: string;
  read: boolean;
  createdAt: string;
}
export interface AuditEntry {
  id: string;
  actorId: string;
  action: string;
  requestId: string;
  objectId?: string;
  result: string;
  createdAt: string;
}
export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
  revision: number;
}
export interface Staff {
  id: string;
  username: string;
  name: string;
  staffRole: StaffRole;
  active: boolean;
}
/** Counts for the signed-in member, independent of the current list pages. */
export interface MemberSummary {
  orderCount: number;
  afterSaleCount: number;
  couponClaimCount: number;
  favoriteCount: number;
  cartQuantity: number;
}
