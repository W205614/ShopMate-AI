import type { ShopApi } from "../../shared/domain/api";
import {
  canonicalProvince,
  deliveryProvinces,
} from "../../shared/domain/delivery-province";
import type { Database, Session } from "../../shared/domain/types";
import type { StockTransfer } from "../../shared/domain/warehouses";
import {
  admin,
  context,
  id,
  move,
  now,
  productSku,
  requireThat,
  transact,
} from "./repository";
import { pendingStock, requireWarehouse, stockRow } from "./warehouse-stock";
import { checkVersion } from "./versions";

function transferAt(
  db: Database,
  actor: Session,
  id: string,
  version: number,
  side: "from" | "to",
) {
  const transfer = db.stockTransfers!.find((entry) => entry.id === id);
  requireThat(transfer, "调拨单不存在");
  requireWarehouse(
    db,
    actor,
    side === "from" ? transfer.fromWarehouseId : transfer.toWarehouseId,
  );
  checkVersion(transfer, version);
  return transfer;
}

export const warehouseApi: Pick<
  ShopApi,
  | "saveWarehouse"
  | "assignWarehouses"
  | "createStockTransfer"
  | "dispatchStockTransfer"
  | "cancelStockTransfer"
  | "receiveStockTransfer"
  | "returnStockTransfer"
> = {
  async saveWarehouse(input) {
    return transact((db) => {
      const existing = db.warehouses!.find(
        (warehouse) => warehouse.id === input.id,
      );
      requireThat(
        !input.id || (existing && input.version !== undefined),
        "仓库不存在或缺少版本",
      );
      if (existing) checkVersion(existing, input.version);
      requireThat(
        !db.warehouses!.some(
          (warehouse) =>
            warehouse.id !== input.id && warehouse.name === input.name,
        ),
        "仓库名称已存在",
      );
      const provinces = [...new Set(input.provinces.map(canonicalProvince))];
      requireThat(
        provinces.every((province) =>
          deliveryProvinces.some((value) => value === province),
        ),
        "请选择有效配送省份",
      );
      const record = {
        ...input,
        returnAddress: input.returnAddress,
        id: existing?.id ?? id("warehouse-"),
        provinces,
        version: (existing?.version ?? 0) + 1,
      };
      if (existing) Object.assign(existing, record);
      else db.warehouses!.push(record);
      return record;
    });
  },
  async assignWarehouses(staffId, warehouseIds) {
    await transact((db) => {
      const staff = context
        .getStore()!
        .sql.prepare("SELECT staff_role FROM staff_access WHERE account_id=?")
        .get(staffId);
      requireThat(staff?.staff_role === "warehouse", "请选择仓库角色员工");
      const wanted = [...new Set(warehouseIds)];
      requireThat(
        wanted.every((warehouseId) =>
          db.warehouses!.some((warehouse) => warehouse.id === warehouseId),
        ),
        "授权仓库不存在",
      );
      const assignment = db.warehouseAssignments!.find(
        (entry) => entry.id === staffId,
      );
      if (assignment) assignment.warehouseIds = wanted;
      else db.warehouseAssignments!.push({ id: staffId, warehouseIds: wanted });
    });
  },
  async createStockTransfer(fromWarehouseId, toWarehouseId, lines) {
    return transact((db) => {
      const actor = admin();
      requireWarehouse(db, actor, fromWarehouseId);
      requireThat(
        fromWarehouseId !== toWarehouseId &&
          db.warehouses!.some((warehouse) => warehouse.id === toWarehouseId),
        "调拨目标须为不同的有效仓库",
      );
      requireThat(
        new Set(lines.map((line) => line.skuId)).size === lines.length,
        "调拨规格不能重复",
      );
      const pending = pendingStock(db);
      for (const line of lines) {
        productSku(db, line.productId, line.skuId);
        const row = stockRow(db, fromWarehouseId, line.productId, line.skuId);
        requireThat(
          row.onHand -
            row.committed -
            row.transferLocked -
            (pending.get(row.id) ?? 0) >=
            line.quantity,
          "调拨数量超过来源仓可用库存",
        );
        row.transferLocked += line.quantity;
      }
      const transfer: StockTransfer = {
        id: id("transfer-"),
        fromWarehouseId,
        toWarehouseId,
        lines: lines.map((line) => ({
          ...line,
          received: 0,
          discrepancy: 0,
          returned: 0,
        })),
        status: "locked",
        createdAt: now(),
        version: 1,
      };
      db.stockTransfers!.unshift(transfer);
      return transfer;
    });
  },
  async dispatchStockTransfer(transferId, version) {
    return transact((db) => {
      const transfer = transferAt(db, admin(), transferId, version, "from");
      requireThat(transfer.status === "locked", "调拨单当前不能出库");
      for (const line of transfer.lines) {
        stockRow(
          db,
          transfer.fromWarehouseId,
          line.productId,
          line.skuId,
        ).transferLocked -= line.quantity;
        move(
          db,
          line.productId,
          line.skuId,
          -line.quantity,
          `调拨出库 ${transfer.id}`,
          transfer.fromWarehouseId,
        );
      }
      transfer.status = "inTransit";
      transfer.version++;
      return transfer;
    });
  },
  async cancelStockTransfer(transferId, version) {
    return transact((db) => {
      const transfer = transferAt(db, admin(), transferId, version, "from");
      requireThat(transfer.status === "locked", "调拨仅在出库前可以撤销");
      for (const line of transfer.lines)
        stockRow(
          db,
          transfer.fromWarehouseId,
          line.productId,
          line.skuId,
        ).transferLocked -= line.quantity;
      transfer.status = "cancelled";
      transfer.version++;
      return transfer;
    });
  },
  async receiveStockTransfer(transferId, version, lines, note) {
    return transact((db) => {
      const transfer = transferAt(db, admin(), transferId, version, "to");
      requireThat(transfer.status === "inTransit", "调拨单当前不能收货");
      requireThat(
        new Set(lines.map((line) => line.skuId)).size === lines.length,
        "收货规格不能重复",
      );
      for (const receipt of lines) {
        const line = transfer.lines.find(
          (entry) => entry.skuId === receipt.skuId,
        );
        const discrepancy = receipt.discrepancy ?? 0;
        requireThat(
          line &&
            receipt.quantity + discrepancy > 0 &&
            line.received +
              line.discrepancy +
              line.returned +
              receipt.quantity +
              discrepancy <=
              line.quantity,
          "收货或差异数量超出在途库存",
        );
        requireThat(!discrepancy || note, "登记调拨差异时请填写原因");
        if (receipt.quantity)
          move(
            db,
            line.productId,
            line.skuId,
            receipt.quantity,
            `调拨入库 ${transfer.id}`,
            transfer.toWarehouseId,
          );
        line.received += receipt.quantity;
        if (discrepancy) {
          line.discrepancy += discrepancy;
          transfer.note = [
            transfer.note,
            `${now()} ${admin().name} ${line.skuId} 少收 ${discrepancy} 件：${note}`,
          ]
            .filter(Boolean)
            .join("\n");
        }
      }
      if (
        transfer.lines.every(
          (line) =>
            line.received + line.discrepancy + line.returned === line.quantity,
        )
      )
        transfer.status = "received";
      transfer.version++;
      return transfer;
    });
  },
  async returnStockTransfer(transferId, version, lines, note) {
    return transact((db) => {
      const actor = admin();
      const transfer = transferAt(db, actor, transferId, version, "from");
      requireThat(transfer.status === "inTransit", "调拨单当前不能登记退回");
      requireThat(
        new Set(lines.map((line) => line.skuId)).size === lines.length,
        "退回规格不能重复",
      );
      for (const receipt of lines) {
        const line = transfer.lines.find(
          (entry) => entry.skuId === receipt.skuId,
        );
        requireThat(
          line &&
            line.received +
              line.discrepancy +
              line.returned +
              receipt.quantity <=
              line.quantity,
          "退回数量超出在途库存",
        );
        move(
          db,
          line.productId,
          line.skuId,
          receipt.quantity,
          `调拨退回 ${transfer.id}`,
          transfer.fromWarehouseId,
        );
        line.returned += receipt.quantity;
        transfer.note = [
          transfer.note,
          `${now()} ${actor.name} ${line.skuId} 退回 ${receipt.quantity} 件：${note}`,
        ]
          .filter(Boolean)
          .join("\n");
      }
      if (
        transfer.lines.every(
          (line) =>
            line.received + line.discrepancy + line.returned === line.quantity,
        )
      )
        transfer.status = "received";
      transfer.version++;
      return transfer;
    });
  },
};
