import type {
  ShippingRule,
  Promotion,
  Supplier,
  PurchaseOrder,
  Staff,
  StaffRole,
} from "../../shared/domain/operations";
import {
  admin,
  transact,
  requireThat,
  id,
  now,
  productSku,
  move,
  ledger,
  userId,
  integer,
} from "./repository";
import { hashPassword, HttpError } from "./auth";
import { context } from "./repository";
import { demand } from "./permissions";

function version(current: { version?: number }, expected: number | undefined) {
  if (expected !== (current.version ?? 0))
    throw new HttpError(
      409,
      "记录已变化，请加载最新内容后重新提交",
      "VERSION_CONFLICT",
    );
}
function safeAmount(value: number) {
  requireThat(integer(value), "金额超出安全范围");
  return value;
}
function authorize(permission: string) {
  demand(admin(), permission);
}
function save<T extends { id: string; version: number }>(
  rows: T[],
  input: Omit<T, "id"> & { id?: string },
  prefix: string,
): T {
  const old = rows.find((v) => v.id === input.id);
  requireThat(!input.id || old, "记录不存在");
  if (old) version(old, input.version);
  const value = {
    ...input,
    id: old?.id ?? id(prefix),
    version: (old?.version ?? 0) + 1,
  } as T;
  if (old) Object.assign(old, value);
  else rows.unshift(value);
  return value;
}
export const operationsApi = {
  async saveShippingRule(input: Omit<ShippingRule, "id"> & { id?: string }) {
    authorize("settings");
    return transact((db) => {
      const rows = (db.shippingRules ??= []);
      requireThat(
        !rows.some((r) => r.province === input.province && r.id !== input.id),
        "每个省份只能配置一条规则",
      );
      return save(rows, input, "shipping-");
    });
  },
  async savePromotion(input: Omit<Promotion, "id"> & { id?: string }) {
    authorize("marketing");
    return transact((db) => {
      requireThat(
        input.discount < input.threshold &&
          Date.parse(input.startsAt) < Date.parse(input.endsAt),
        "满减金额或时间范围无效",
      );
      return save((db.promotions ??= []), input, "promotion-");
    });
  },
  async saveSupplier(input: Omit<Supplier, "id"> & { id?: string }) {
    authorize("warehouse");
    return transact((db) => save((db.suppliers ??= []), input, "supplier-"));
  },
  async createPurchaseOrder(input: {
    supplierId: string;
    lines: {
      productId: string;
      skuId: string;
      quantity: number;
      unitCost: number;
    }[];
  }) {
    authorize("warehouse");
    return transact((db) => {
      requireThat(
        db.suppliers?.some((s) => s.id === input.supplierId && s.active),
        "供应商不存在或已停用",
      );
      requireThat(
        new Set(input.lines.map((l) => l.skuId)).size === input.lines.length,
        "采购规格不能重复",
      );
      for (const line of input.lines) {
        productSku(db, line.productId, line.skuId);
        safeAmount(line.quantity * line.unitCost);
      }
      const po: PurchaseOrder = {
        id: id("po-"),
        supplierId: input.supplierId,
        lines: input.lines.map((l) => ({ ...l, received: 0 })),
        receipts: [],
        status: "draft",
        createdAt: now(),
        version: 1,
      };
      (db.purchaseOrders ??= []).unshift(po);
      return po;
    });
  },
  async orderPurchase(poId: string, expectedVersion: number) {
    authorize("warehouse");
    return transact((db) => {
      const po = db.purchaseOrders?.find((p) => p.id === poId);
      requireThat(po, "采购单不存在");
      version(po, expectedVersion);
      requireThat(
        po.status === "draft" &&
          db.suppliers?.some((s) => s.id === po.supplierId && s.active),
        "仅有效供应商的草稿单可下达",
      );
      po.status = "ordered";
      po.version++;
      return po;
    });
  },
  async cancelPurchase(poId: string, expectedVersion: number) {
    authorize("warehouse");
    return transact((db) => {
      const po = db.purchaseOrders?.find((p) => p.id === poId);
      requireThat(po, "采购单不存在");
      version(po, expectedVersion);
      requireThat(
        ["draft", "ordered"].includes(po.status) && !po.receipts.length,
        "已有入库记录不能取消",
      );
      po.status = "cancelled";
      po.version++;
      return po;
    });
  },
  async receivePurchase(input: {
    id: string;
    version: number;
    lines: { skuId: string; quantity: number }[];
  }) {
    authorize("warehouse");
    return transact((db) => {
      const po = db.purchaseOrders?.find((p) => p.id === input.id);
      requireThat(po, "采购单不存在");
      version(po, input.version);
      requireThat(
        ["ordered", "partial"].includes(po.status),
        "当前采购单不能入库",
      );
      requireThat(
        new Set(input.lines.map((l) => l.skuId)).size === input.lines.length,
        "入库规格不能重复",
      );
      let amount = 0;
      const movementIds: string[] = [];
      for (const receipt of input.lines) {
        const line = po.lines.find((l) => l.skuId === receipt.skuId);
        requireThat(
          line &&
            integer(receipt.quantity, 1) &&
            line.received + receipt.quantity <= line.quantity,
          "入库数量超过采购剩余数量",
        );
        movementIds.push(
          move(
            db,
            line.productId,
            line.skuId,
            receipt.quantity,
            `采购入库 ${po.id}`,
          ).id,
        );
        amount = safeAmount(
          amount + safeAmount(receipt.quantity * line.unitCost),
        );
        line.received += receipt.quantity;
      }
      const receipt = {
        id: id("receipt-"),
        createdAt: now(),
        lines: input.lines,
        amount,
        movementIds,
      };
      po.receipts.push(receipt);
      const entry = ledger(
        db,
        "purchase",
        amount,
        receipt.id,
        `采购单 ${po.id}`,
      );
      entry.inventoryMovementId = movementIds[0];
      po.status = po.lines.every((l) => l.received === l.quantity)
        ? "received"
        : "partial";
      po.version++;
      return po;
    });
  },
  async inspectReturn(input: {
    id: string;
    version: number;
    good: number;
    defective: number;
    note: string;
  }) {
    authorize("warehouse");
    return transact((db) => {
      const inspection = db.returnInspections?.find((i) => i.id === input.id);
      requireThat(inspection, "质检记录不存在");
      version(inspection, input.version);
      requireThat(
        inspection.status === "pending" &&
          input.good + input.defective === inspection.quantity,
        "良品和次品数量必须等于本次退货数量",
      );
      if (input.good)
        move(
          db,
          inspection.productId,
          inspection.skuId,
          input.good,
          `退货良品质检入库 ${inspection.id}`,
        );
      Object.assign(inspection, {
        good: input.good,
        defective: input.defective,
        status: "inspected",
        note: input.note,
        inspectedAt: now(),
        version: inspection.version + 1,
      });
      return inspection;
    });
  },
  async disposeReturn(input: {
    id: string;
    version: number;
    quantity: number;
    note: string;
  }) {
    authorize("warehouse");
    return transact((db) => {
      const inspection = db.returnInspections?.find((i) => i.id === input.id);
      requireThat(inspection, "质检记录不存在");
      version(inspection, input.version);
      requireThat(
        inspection.status === "inspected" &&
          input.quantity <= inspection.defective - inspection.disposed,
        "处置数量超出隔离次品数量",
      );
      inspection.disposed += input.quantity;
      inspection.note += `\n处置 ${input.quantity} 件：${input.note}`;
      inspection.version++;
      return inspection;
    });
  },
  async markNotificationRead(notificationId: string) {
    return transact((db) => {
      const notification = db.notifications?.find(
        (n) => n.id === notificationId && n.userId === userId(),
      );
      requireThat(notification, "通知不存在");
      notification.read = true;
    });
  },
  async saveStaff(input: {
    id?: string;
    username: string;
    name: string;
    password?: string;
    staffRole: StaffRole;
    active: boolean;
  }) {
    authorize("staff");
    const hash = input.password
      ? await hashPassword(input.password)
      : undefined;
    return transact(() => {
      const sql = context.getStore()!.sql;
      const actor = admin();
      const owner = sql
        .prepare(
          "SELECT s.staff_role AS role,s.active FROM accounts a JOIN staff_access s ON s.account_id=a.id WHERE a.id=? AND a.role='admin'",
        )
        .get(actor.id);
      if (!owner || owner.role !== "owner" || !owner.active)
        throw new HttpError(403, "店主权限已变更，请重新登录");
      if (input.id) {
        const current = sql
          .prepare(
            "SELECT a.id,a.username,s.staff_role AS staffRole,s.active FROM accounts a JOIN staff_access s ON s.account_id=a.id WHERE a.id=? AND a.role='admin'",
          )
          .get(input.id) as
          | {
              id: string;
              username: string;
              staffRole: StaffRole;
              active: number;
            }
          | undefined;
        requireThat(current, "员工不存在");
        requireThat(current.username === input.username, "员工账号不可修改");
        if (
          current.staffRole === "owner" &&
          (!input.active || input.staffRole !== "owner")
        ) {
          const owners = sql
            .prepare(
              "SELECT count(*) AS count FROM accounts a JOIN staff_access s ON a.id=s.account_id WHERE a.role='admin' AND s.staff_role='owner' AND s.active=1",
            )
            .get() as { count: number };
          requireThat(owners.count > 1, "不能停用或降级最后一位店主");
        }
        sql
          .prepare("UPDATE accounts SET name=? WHERE id=?")
          .run(input.name, input.id);
        if (hash)
          sql
            .prepare("UPDATE accounts SET password_hash=? WHERE id=?")
            .run(hash, input.id);
        sql
          .prepare(
            "INSERT INTO staff_access VALUES (?,?,?) ON CONFLICT(account_id) DO UPDATE SET staff_role=excluded.staff_role,active=excluded.active",
          )
          .run(input.id, input.staffRole, Number(input.active));
        sql.prepare("DELETE FROM sessions WHERE account_id=?").run(input.id);
      } else {
        requireThat(hash, "新员工必须设置密码");
        if (
          sql
            .prepare("SELECT id FROM accounts WHERE username=?")
            .get(input.username)
        )
          throw new HttpError(409, "该账号已存在");
        const accountId = id("staff-");
        sql
          .prepare("INSERT INTO accounts VALUES (?,?,?,?,?,?)")
          .run(
            accountId,
            input.username,
            input.name,
            "admin",
            hash,
            Date.now(),
          );
        sql
          .prepare("INSERT INTO staff_access VALUES (?,?,?)")
          .run(accountId, input.staffRole, Number(input.active));
        input = { ...input, id: accountId };
      }
      return {
        id: input.id,
        username: input.username,
        name: input.name,
        staffRole: input.staffRole,
        active: input.active,
      } as Staff;
    });
  },
};
