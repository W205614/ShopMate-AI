import type { StockAdjustmentOptions } from "../domain/types";
export interface StockRecovery {
  productId: string;
  skuId: string;
  name: string;
  beforeStock: number;
  quantity: number;
  cost: number;
  reason: string;
  options: StockAdjustmentOptions;
  createdAt: number;
}
const key = (adminId: string) =>
  `shopmate:stock-recovery:${encodeURIComponent(adminId)}`;
export function readStockRecovery(adminId: string): StockRecovery | null {
  try {
    const raw = sessionStorage.getItem(key(adminId));
    if (!raw) return null;
    const value = JSON.parse(raw) as StockRecovery;
    if (
      !value ||
      !Number.isFinite(value.createdAt) ||
      value.createdAt > Date.now() ||
      Date.now() - value.createdAt >= 86400000 ||
      ![
        value.productId,
        value.skuId,
        value.name,
        value.reason,
        value.options?.requestId,
      ].every(
        (s) => typeof s === "string" && s.length > 0 && s.length <= 300,
      ) ||
      !Number.isSafeInteger(value.quantity) ||
      !Number.isSafeInteger(value.beforeStock) ||
      value.beforeStock < 0 ||
      !Number.isSafeInteger(value.cost) ||
      value.cost < 0 ||
      !["delta", "count"].includes(value.options.mode ?? "delta") ||
      (value.options.mode === "count" &&
        (!Number.isSafeInteger(value.options.expectedStock) ||
          value.options.expectedStock! < 0 ||
          value.quantity < 0 ||
          value.cost !== 0))
    ) {
      sessionStorage.removeItem(key(adminId));
      return null;
    }
    return value;
  } catch {
    return null;
  }
}
export function saveStockRecovery(adminId: string, input: StockRecovery) {
  try {
    sessionStorage.setItem(key(adminId), JSON.stringify(input));
  } catch {
    throw new Error(
      "无法保存库存请求恢复信息，请启用当前页存储后重试；尚未提交库存操作",
    );
  }
}
export function clearStockRecovery(adminId: string, requestId: string) {
  if (readStockRecovery(adminId)?.options.requestId !== requestId) return;
  try {
    sessionStorage.removeItem(key(adminId));
  } catch {
    /* A retained marker is safe to resolve against the server again. */
  }
}
