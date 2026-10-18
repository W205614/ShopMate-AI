import { expect, it } from "vitest";
import {
  ledgerAmount,
  ledgerMoney,
  ledgerCsv,
  sumLedger,
  ledgerAssociation,
} from "./finance";
import type { LedgerEntry, Database } from "./types";
const row: LedgerEntry = {
  id: "l1",
  type: "purchase",
  amount: Number.MAX_SAFE_INTEGER,
  reference: "sku1",
  note: ' =SUM(1,2)\n"说明"',
  createdAt: "2026-10-17T00:00:00Z",
};
it("单笔安全整数及超安全整数汇总保留每一分，不转浮点元", () => {
  expect(ledgerAmount(row.amount)).toBe("90071992547409.91");
  const sums = sumLedger([row, row, row]);
  expect(sums.purchase).toBe(27021597764222973n);
  expect(ledgerMoney(sums.purchase)).toBe("¥270,215,977,642,229.73");
  expect(ledgerMoney(-1n)).toBe("¥-0.01");
});
it("导出保留BOM和完整整数分，同时转义引号换行及公式前缀", () => {
  const csv = ledgerCsv([row], (at) => at);
  expect(csv.startsWith("\uFEFF")).toBe(true);
  expect(csv).toContain('"90071992547409.91"');
  expect(csv).toContain('"\' =SUM(1,2)\n""说明"""');
  expect(csv).toContain('"历史仅关联 SKU，无法定位单次变动"');
});
it("只使用精确库存关联，不猜测旧SKU或丢失的变动", () => {
  const db = {
    orders: [{ id: "order1" }],
    inventory: [{ id: "move1", skuId: "sku1" }],
  } as Pick<Database, "orders" | "inventory">;
  expect(ledgerAssociation(row, db)).toMatchObject({
    label: "搜索该 SKU 相关记录",
    query: { q: "sku1" },
  });
  expect(
    ledgerAssociation({ ...row, inventoryMovementId: "move1" }, db),
  ).toMatchObject({ label: "查看库存变动", query: { detail: "move1" } });
  expect(
    ledgerAssociation({ ...row, inventoryMovementId: "missing" }, db),
  ).toMatchObject({ label: "", notice: "关联库存变动不可用" });
  expect(
    ledgerAssociation(
      { ...row, reference: "wrong-sku", inventoryMovementId: "move1" },
      db,
    ),
  ).toMatchObject({ label: "", notice: "关联库存变动不可用" });
  const receiptDb = {
    ...db,
    purchaseOrders: [
      { receipts: [{ id: "receipt1", movementIds: ["move1"] }] },
    ],
  } as Pick<Database, "orders" | "inventory" | "purchaseOrders">;
  expect(
    ledgerAssociation(
      { ...row, reference: "receipt1", inventoryMovementId: "move1" },
      receiptDb,
    ),
  ).toMatchObject({ label: "查看库存变动", query: { detail: "move1" } });
  expect(
    ledgerAssociation({ ...row, type: "refund", reference: "order1" }, db),
  ).toMatchObject({ label: "查看订单", query: { detail: "order1" } });
});
