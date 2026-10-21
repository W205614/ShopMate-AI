import type { Session } from "../../shared/domain/types";
import type { StaffRole } from "../../shared/domain/operations";
import { HttpError } from "./auth";
export const grants: Record<StaffRole, string[]> = {
  owner: [
    "catalog",
    "marketing",
    "warehouse",
    "support",
    "finance",
    "settings",
    "staff",
    "audit",
  ],
  operations: ["catalog", "marketing"],
  warehouse: ["warehouse"],
  support: ["support"],
  finance: ["finance"],
};
export function permits(session: Session | null, permission: string) {
  return (
    !!session &&
    (session.permissions ?? grants[session.staffRole ?? "owner"]).includes(
      permission,
    )
  );
}
export function demand(session: Session | null, permission: string) {
  if (!session) throw new HttpError(401, "请先登录管理账号");
  if (!permits(session, permission))
    throw new HttpError(403, "当前员工没有此操作权限");
}
export function methodPermission(method: string, args: unknown[]): string {
  if (method === "processAfterSale")
    return args[1] === "refund"
      ? "finance"
      : args[1] === "receive"
        ? "warehouse"
        : "support";
  if (/^(saveProduct|toggleProduct|saveCategory|deleteCategory)$/.test(method))
    return "catalog";
  if (/^(saveCoupon|toggleCoupon|savePromotion)$/.test(method))
    return "marketing";
  if (
    /^(adjustStock|shipOrder|saveSupplier|createPurchaseOrder|orderPurchase|receivePurchase|cancelPurchase|inspectReturn|disposeReturn)$/.test(
      method,
    )
  )
    return "warehouse";
  if (/^(createStaff|saveStaff)$/.test(method)) return "staff";
  if (/^(saveSettings|saveShippingRule|resetDemo|retryJob)$/.test(method))
    return "settings";
  return "support";
}
export function collectionPermission(collection: string): string[] {
  const map: Record<string, string[]> = {
    users: ["support", "finance", "warehouse"],
    orders: ["warehouse", "support", "finance"],
    afterSales: ["support", "warehouse", "finance"],
    inventory: ["warehouse"],
    inventoryRequests: ["warehouse"],
    ledger: ["finance"],
    conversations: ["support"],
    coupons: ["marketing"],
    couponClaims: ["marketing"],
    reviews: ["marketing", "catalog", "support"],
    promotions: ["marketing"],
    shippingRules: ["settings"],
    suppliers: ["warehouse"],
    purchaseOrders: ["warehouse"],
    returnInspections: ["warehouse"],
    auditEntries: ["audit"],
    checkoutQuotes: ["support"],
    orderRequests: ["support"],
    pointsEntries: ["finance", "support"],
  };
  return map[collection] ?? [];
}
