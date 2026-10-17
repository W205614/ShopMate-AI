import type { Database, LedgerEntry } from "./types";
import { money } from "./types";
export const ledgerLabels = {
  payment: "模拟收款",
  refund: "模拟退款",
  purchase: "采购支出",
};
export function sumLedger(rows: LedgerEntry[]) {
  const sums = { payment: 0n, refund: 0n, purchase: 0n };
  for (const row of rows) sums[row.type] += BigInt(row.amount);
  return sums;
}
export function ledgerAmount(cents: number | bigint, grouped = false) {
  const value = BigInt(cents),
    absolute = value < 0n ? -value : value;
  const whole = absolute / 100n;
  return `${value < 0n ? "-" : ""}${grouped ? whole.toLocaleString("zh-CN") : whole}.${String(absolute % 100n).padStart(2, "0")}`;
}
export const ledgerMoney = money;
function cell(value: unknown) {
  let str = String(value ?? "");
  if (/^[\s]*[=+\-@]/.test(str)) str = "'" + str;
  return '"' + str.replace(/"/g, '""') + '"';
}
export function ledgerCsv(
  rows: LedgerEntry[],
  formatDate: (at: string) => string,
) {
  const lines = [
    [
      "流水号",
      "类型",
      "金额（元）",
      "关联编号",
      "说明",
      "时间",
      "库存变动关联",
    ],
    ...rows.map((l) => [
      l.id,
      ledgerLabels[l.type],
      ledgerAmount(l.amount),
      l.reference,
      l.note,
      formatDate(l.createdAt),
      l.inventoryMovementId ??
        (l.type === "purchase" ? "历史仅关联 SKU，无法定位单次变动" : ""),
    ]),
  ];
  return "\uFEFF" + lines.map((line) => line.map(cell).join(",")).join("\r\n");
}
export function ledgerAssociation(
  entry: LedgerEntry,
  db: Pick<Database, "orders" | "inventory">,
) {
  if (entry.type !== "purchase")
    return db.orders.some((o) => o.id === entry.reference)
      ? {
          label: "查看订单",
          notice: "",
          path: "/admin/orders",
          query: { detail: entry.reference },
        }
      : { label: "", notice: "关联订单不可用", path: "", query: {} };
  if (entry.inventoryMovementId)
    return db.inventory.some(
      (m) => m.id === entry.inventoryMovementId && m.skuId === entry.reference,
    )
      ? {
          label: "查看库存变动",
          notice: "精确关联本次库存变动",
          path: "/admin/inventory",
          query: { tab: "records", detail: entry.inventoryMovementId },
        }
      : { label: "", notice: "关联库存变动不可用", path: "", query: {} };
  return {
    label: "搜索该 SKU 相关记录",
    notice: "历史仅关联 SKU，无法定位单次变动",
    path: "/admin/inventory",
    query: { tab: "records", q: entry.reference },
  };
}
