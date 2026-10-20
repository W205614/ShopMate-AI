import type { ShopApi } from "../../shared/domain/api";
import type { DatabaseSync } from "node:sqlite";
import type { Database, Order } from "../../shared/domain/types";
import { readDatabase, writeDatabase, transaction } from "./database";
import { ensureRuntimeSchema, enqueue } from "./runtime";
import { releaseSnapshot } from "./storage";
import {
  context,
  transact,
  userId,
  productSku,
  requireThat,
  integer,
  id,
  text,
  clone,
  ownedOrder,
  now,
  move,
  ledger,
  admin,
} from "./repository";
import {
  availableStock,
  syncOrderPoints,
  activeAfterSale,
  checkoutSnapshot,
  expireOrders,
  refundThrough,
  releaseCoupon,
} from "./commerce-rules";

export function expirePendingOrders(sql: DatabaseSync) {
  ensureRuntimeSchema(sql);
  return transaction(sql, () => {
    const at = new Date().toISOString();
    const cutoff = new Date(Date.parse(at) - 86400000).toISOString();
    const db = readDatabase(sql, {
      pendingOnly: true,
      domains: {
        checkoutQuotes: { expiredBefore: at },
        orderRequests: { expiredBefore: cutoff },
        inventoryRequests: { expiredBefore: cutoff },
      },
    });
    try {
      const pendingIds = new Set(
        db.orders.filter((o) => o.status === "pending").map((o) => o.id),
      );
      const changed = expireOrders(db);
      if (changed) {
        for (const order of db.orders)
          if (pendingIds.has(order.id) && order.status === "cancelled")
            enqueue(
              sql,
              "notification",
              {
                userId: order.userId,
                orderId: order.id,
                text: "订单付款超时，已关闭并释放库存预占",
              },
              `expiry:${order.id}`,
            );
        db.revision++;
        writeDatabase(sql, db);
      }
      return changed;
    } finally {
      releaseSnapshot(db);
    }
  });
}
const addEvent = (
  order: Order,
  action: string,
  actor: "user" | "admin" | "system",
  note?: string,
) => order.events.push({ at: now(), actor, action, ...(note ? { note } : {}) });
const validCart = (
  db: Database,
  item: { productId: string; skuId: string; quantity: number },
) => {
  const product = db.products.find((p) => p.id === item.productId),
    sku = product?.skus.find((s) => s.id === item.skuId);
  return (
    !!product?.active &&
    !!sku &&
    item.quantity > 0 &&
    item.quantity <= availableStock(db, product.id, sku.id)
  );
};
const hasSale = (db: Database, orderId: string) =>
  db.afterSales.some((a) => a.orderId === orderId && activeAfterSale(a.status));

export const commerceApi: Pick<
  ShopApi,
  | "addCart"
  | "updateCart"
  | "removeCart"
  | "batchCart"
  | "clearInvalidCart"
  | "favorite"
  | "saveAddress"
  | "deleteAddress"
  | "quoteCheckout"
  | "createOrder"
  | "retireCheckout"
  | "payOrder"
  | "cancelOrder"
  | "confirmOrder"
  | "reorder"
  | "requestAfterSale"
  | "cancelAfterSale"
  | "submitReturn"
  | "shipOrder"
  | "processAfterSale"
> = {
  async addCart(productId, skuId, quantity) {
    await transact((db) => addCartChange(db, productId, skuId, quantity));
  },
  async updateCart(cartId, patch) {
    await transact((db) => {
      const item = db.carts.find(
        (c) => c.id === cartId && c.userId === userId(),
      );
      requireThat(item, "购物车条目不存在");
      if (patch.quantity !== undefined) {
        const { sku, product } = productSku(db, item.productId, item.skuId);
        requireThat(
          product.active &&
            integer(patch.quantity, 1) &&
            patch.quantity <= availableStock(db, product.id, sku.id),
          "数量必须为正整数且不能超过库存",
        );
        item.quantity = patch.quantity;
      }
      if (patch.selected !== undefined) {
        requireThat(typeof patch.selected === "boolean", "勾选状态无效");
        requireThat(!patch.selected || validCart(db, item), "商品当前不可结算");
        item.selected = patch.selected;
      }
    });
  },
  async removeCart(cartId) {
    await commerceApi.batchCart({ ids: [cartId], action: "remove" });
  },
  async batchCart(input) {
    await transact((db) => {
      const uid = userId();
      requireThat(new Set(input.ids).size === input.ids.length, "条目不能重复");
      const items = input.ids.map((cartId) =>
        db.carts.find((c) => c.id === cartId && c.userId === uid),
      );
      requireThat(items.every(Boolean), "购物车条目不存在或不属于当前用户");
      if (input.action === "remove")
        db.carts = db.carts.filter(
          (c) => !(c.userId === uid && input.ids.includes(c.id)),
        );
      else {
        requireThat(
          input.action === "select" && typeof input.selected === "boolean",
          "批量操作无效",
        );
        for (const item of items)
          item!.selected = input.selected && validCart(db, item!);
      }
    });
  },
  async clearInvalidCart() {
    await transact((db) => {
      const uid = userId();
      db.carts = db.carts.filter(
        (c) =>
          c.userId !== uid ||
          !!db.products.find(
            (p) =>
              p.id === c.productId &&
              p.active &&
              p.skus.some((s) => s.id === c.skuId),
          ),
      );
    });
  },
  async favorite(productId, desired) {
    await transact((db) => {
      const uid = userId(),
        favorites = db.favorites[uid] ?? [];
      if (
        desired === false ||
        (desired === undefined && favorites.includes(productId))
      )
        db.favorites[uid] = favorites.filter((p) => p !== productId);
      else if (!favorites.includes(productId)) {
        requireThat(
          db.products.some((p) => p.id === productId && p.active),
          "商品不存在或已下架",
        );
        db.favorites[uid] = [...favorites, productId];
      }
    });
  },
  async saveAddress(input) {
    await transact((db) => {
      const uid = userId();
      requireThat(
        text(input.name, 50) &&
          /^1\d{10}$/.test(input.phone) &&
          text(input.region, 100) &&
          text(input.detail, 200),
        "请填写收货人、11 位手机号、地区与详细地址",
      );
      const existing = input.id
        ? db.addresses.find((a) => a.id === input.id && a.userId === uid)
        : undefined;
      requireThat(!input.id || existing, "地址不存在或不属于当前用户");
      const value = {
        ...input,
        name: input.name.trim(),
        region: input.region.trim(),
        detail: input.detail.trim(),
        id: existing?.id ?? id("addr-"),
        userId: uid,
      };
      if (existing) Object.assign(existing, value);
      else db.addresses.push(value);
      const own = db.addresses.filter((a) => a.userId === uid);
      const chosen =
        (input.isDefault
          ? own.find((a) => a.id === value.id)
          : own.find((a) => a.isDefault)) ?? own[0];
      for (const address of own) address.isDefault = address === chosen;
    });
  },
  async deleteAddress(addressId) {
    await transact((db) => {
      const uid = userId();
      requireThat(
        db.addresses.some((a) => a.id === addressId && a.userId === uid),
        "地址不存在或不属于当前用户",
      );
      db.addresses = db.addresses.filter((a) => a.id !== addressId);
      const own = db.addresses.filter((a) => a.userId === uid),
        chosen = own.find((a) => a.isDefault) ?? own[0];
      for (const a of own) a.isDefault = a === chosen;
    });
  },
  async quoteCheckout(input) {
    return transact((db) => {
      const uid = userId();
      expireOrders(db, now(), false);
      const snapshot = checkoutSnapshot(db, uid, input),
        createdAt = now();
      const quote = {
        id: id("quote-"),
        userId: uid,
        input: clone(input),
        ...snapshot,
        createdAt,
        expiresAt: new Date(Date.parse(createdAt) + 300000).toISOString(),
      };
      db.checkoutQuotes.push(quote);
      return clone(quote);
    });
  },
  async retireCheckout(input) {
    return transact((db) => {
      const uid = userId();
      const binding = db.orderRequests.find(
        (r) => r.userId === uid && r.requestId === input.requestId,
      );
      requireThat(
        !binding || binding.quoteId === input.quoteId,
        "同一请求标识不能用于不同报价",
      );
      const quote = db.checkoutQuotes.find(
        (q) => q.id === input.quoteId && q.userId === uid,
      );
      const orderId = binding?.orderId ?? quote?.orderId;
      if (orderId) {
        requireThat(
          db.orders.some((o) => o.id === orderId && o.userId === uid),
          "订单不存在或不属于当前用户",
        );
        return orderId;
      }
      if (quote && quote.expiresAt > now()) quote.expiresAt = now();
      return null;
    });
  },
  async createOrder(input) {
    return transact((db) => {
      const uid = userId(),
        at = now();
      expireOrders(db, at, false);
      requireThat(
        text(input.requestId, 128) && text(input.quoteId, 128),
        "报价或请求标识无效",
      );
      const previous = db.orderRequests.find(
        (r) => r.userId === uid && r.requestId === input.requestId,
      );
      if (previous) {
        requireThat(
          previous.quoteId === input.quoteId,
          "同一请求标识不能用于不同报价",
        );
        return previous.orderId;
      }
      const quote = db.checkoutQuotes.find(
        (q) => q.id === input.quoteId && q.userId === uid,
      );
      requireThat(quote, "报价不存在或已过期，请重新确认");
      if (quote.orderId) {
        db.orderRequests.push({
          userId: uid,
          requestId: input.requestId,
          quoteId: quote.id,
          orderId: quote.orderId,
          createdAt: at,
        });
        return quote.orderId;
      }
      requireThat(quote.expiresAt > at, "报价已过期，请重新确认");
      const snapshot = checkoutSnapshot(db, uid, quote.input);
      requireThat(
        snapshot.fingerprint === quote.fingerprint,
        "商品、地址、优惠券或购物车已变化，请重新确认报价",
      );
      const orderId = id("SM");
      db.orders.unshift({
        id: orderId,
        userId: uid,
        items: clone(quote.items).map((item) => ({
          ...item,
          id: `${orderId}-${item.id}`,
        })),
        inventoryPolicy: "reserved-v1",
        pointsPolicy: "earned-v1",
        pointsAwarded: 0,
        afterSaleDays: context.getStore()?.afterSaleDays ?? 7,
        shipping: clone(quote.shipping),
        shippingFee: quote.shippingFee ?? 0,
        shippingRefunded: 0,
        promotion: clone(quote.promotion),
        subtotal: quote.subtotal,
        discount: quote.discount,
        total: quote.total,
        refundedAmount: 0,
        status: "pending",
        address: clone(quote.address),
        createdAt: at,
        expiresAt: new Date(Date.parse(at) + 1800000).toISOString(),
        events: [{ at, actor: "user", action: "created" }],
        coupon: clone(quote.coupon),
        quoteId: quote.id,
      });
      if (quote.coupon) {
        const claim = db.couponClaims.find(
          (c) => c.id === quote.coupon!.claimId,
        )!;
        claim.status = "locked";
        claim.orderId = orderId;
      }
      if (quote.input.source.type === "cart") {
        const ids = quote.input.source.cartIds;
        db.carts = db.carts.filter(
          (c) => !(c.userId === uid && ids.includes(c.id)),
        );
      }
      quote.orderId = orderId;
      db.orderRequests.push({
        userId: uid,
        requestId: input.requestId,
        quoteId: quote.id,
        orderId,
        createdAt: at,
      });
      return orderId;
    });
  },
  async payOrder(orderId) {
    // Persist deadline closure before rejecting payment, rather than rolling it back with the error.
    expirePendingOrders(context.getStore()!.sql);
    await transact((db) => {
      const order = ownedOrder(db, orderId);
      if (["paid", "shipped", "completed", "refunded"].includes(order.status))
        return;
      requireThat(
        order.status === "pending",
        "当前订单不能付款（已取消或付款超时）",
      );
      for (const item of order.items) {
        const { product, sku } = productSku(db, item.productId, item.skuId);
        requireThat(
          product.active &&
            availableStock(
              db,
              product.id,
              sku.id,
              order.inventoryPolicy === "reserved-v1" ? order.id : undefined,
            ) >= item.quantity,
          `${item.name}已下架或库存不足，无法支付`,
        );
      }
      for (const item of order.items)
        move(
          db,
          item.productId,
          item.skuId,
          -item.quantity,
          `订单付款 ${order.id}`,
        );
      if (order.coupon) {
        const claim = db.couponClaims.find(
          (c) => c.id === order.coupon!.claimId,
        );
        requireThat(
          claim?.status === "locked" && claim.orderId === order.id,
          "订单优惠券状态无效",
        );
        claim.status = "used";
      }
      order.status = "paid";
      order.paidAt = now();
      addEvent(order, "paid", "user");
      ledger(db, "payment", order.total, order.id, "模拟订单收款");
    });
  },
  async cancelOrder(orderId) {
    await transact((db) => cancelOrderChange(db, orderId));
  },
  async confirmOrder(orderId) {
    await transact((db) => {
      const order = ownedOrder(db, orderId);
      if (order.status === "completed") return;
      requireThat(order.status === "shipped", "只有待收货订单可以确认收货");
      requireThat(!hasSale(db, orderId), "售后处理中，暂不能确认收货");
      order.status = "completed";
      order.completedAt = now();
      addEvent(order, "completed", "user");
      syncOrderPoints(db, order);
    });
  },
  async reorder(orderId) {
    return transact((db) => {
      const order = ownedOrder(db, orderId),
        uid = userId(),
        result = { added: 0, addedQuantity: 0, skipped: [] as string[] };
      for (const item of order.items) {
        const existing = db.carts.find(
          (c) =>
            c.userId === uid &&
            c.productId === item.productId &&
            c.skuId === item.skuId,
        );
        const requested = {
          ...item,
          quantity: item.quantity + (existing?.quantity ?? 0),
        };
        const product = db.products.find((p) => p.id === item.productId);
        const sku = product?.skus.find((s) => s.id === item.skuId);
        const reason =
          !product || !product.active
            ? "商品已下架或移除"
            : !sku
              ? "规格已失效"
              : !integer(item.quantity, 1) || !integer(requested.quantity, 1)
                ? "购买数量无效"
                : requested.quantity > availableStock(db, product!.id, sku.id)
                  ? `库存不足（库存 ${sku.stock} 件，购物车已有 ${existing?.quantity ?? 0} 件，本次需 ${item.quantity} 件）`
                  : "";
        if (reason) {
          result.skipped.push(`${item.name} ${item.skuName}：${reason}`);
          continue;
        }
        if (existing) {
          existing.quantity += item.quantity;
          existing.selected = true;
        } else
          db.carts.push({
            id: id("cart-"),
            userId: uid,
            productId: item.productId,
            skuId: item.skuId,
            quantity: item.quantity,
            selected: true,
          });
        result.added++;
        result.addedQuantity += item.quantity;
      }
      return result;
    });
  },
  async requestAfterSale(orderId, reason, description, lines) {
    await transact((db) =>
      requestAfterSaleChange(db, orderId, reason, description, lines),
    );
  },
  async cancelAfterSale(afterSaleId) {
    await transact((db) => {
      const sale = db.afterSales.find(
        (a) => a.id === afterSaleId && a.userId === userId(),
      );
      requireThat(sale, "售后不存在或不属于当前用户");
      requireThat(
        ["requested", "approved"].includes(sale.status) && !sale.returnTracking,
        "当前售后不可撤销",
      );
      sale.status = "cancelled";
      sale.events.push({ at: now(), actor: "user", action: "cancelled" });
    });
  },
  async submitReturn(afterSaleId, carrier, tracking) {
    await transact((db) => {
      const sale = db.afterSales.find(
        (a) => a.id === afterSaleId && a.userId === userId(),
      );
      requireThat(sale, "售后不存在或不属于当前用户");
      requireThat(
        sale.requiresReturn && sale.status === "approved",
        "当前售后不可提交退货单号",
      );
      requireThat(
        text(carrier, 60) && text(tracking, 80),
        "请填写退货承运商与单号",
      );
      sale.returnCarrier = carrier.trim();
      sale.returnTracking = tracking.trim();
      sale.status = "returning";
      sale.events.push({
        at: now(),
        actor: "user",
        action: "returning",
        note: `${sale.returnCarrier} ${sale.returnTracking}`,
      });
    });
  },
  async shipOrder(orderId, carrier, tracking) {
    await transact((db) => {
      admin();
      const order = db.orders.find((o) => o.id === orderId);
      requireThat(order, "订单不存在");
      requireThat(order.status === "paid", "只有待发货订单可以发货");
      requireThat(!hasSale(db, orderId), "售后处理中，不能发货");
      requireThat(
        text(carrier, 60) && text(tracking, 80),
        "请填写物流公司与单号",
      );
      order.status = "shipped";
      order.carrier = carrier.trim();
      order.tracking = tracking.trim();
      order.shippedAt = now();
      addEvent(order, "shipped", "admin", `${order.carrier} ${order.tracking}`);
    });
  },
  async processAfterSale(afterSaleId, action, note = "") {
    await transact((db) => {
      admin();
      const sale = db.afterSales.find((a) => a.id === afterSaleId);
      requireThat(sale, "售后不存在");
      const order = db.orders.find((o) => o.id === sale.orderId);
      requireThat(order, "关联订单不存在");
      if (action === "refund" && sale.status === "refunded") return;
      if (action === "approve" || action === "reject") {
        requireThat(sale.status === "requested", "当前状态不可重复审核");
        if (action === "reject")
          requireThat(text(note, 500), "拒绝申请需要填写原因");
        sale.status = action === "approve" ? "approved" : "rejected";
      } else if (action === "receive") {
        requireThat(
          sale.requiresReturn &&
            sale.status === "returning" &&
            sale.returnTracking &&
            sale.returnCarrier,
          "只有已提交退货单号的申请可以记录收货",
        );
        sale.status = "received";
        if (order.inventoryPolicy === "reserved-v1") {
          const inspections = (db.returnInspections ??= []);
          for (const line of sale.lines) {
            const item = order.items.find((i) => i.id === line.orderItemId)!;
            requireThat(item, "退货订单条目不存在");
            inspections.push({
              id: id("inspection-"),
              afterSaleId: sale.id,
              orderItemId: item.id,
              productId: item.productId,
              skuId: item.skuId,
              quantity: line.quantity,
              good: 0,
              defective: 0,
              disposed: 0,
              status: "pending",
              note: "",
              createdAt: now(),
              version: 1,
            });
          }
        }
      } else {
        requireThat(action === "refund", "售后操作无效");
        requireThat(
          sale.requiresReturn
            ? sale.status === "received"
            : sale.status === "approved",
          "请先完成审核及必要的退货收货",
        );
        requireThat(
          ["paid", "shipped", "completed"].includes(order.status),
          "订单当前不能退款",
        );
        let amount = 0;
        for (const line of sale.lines) {
          const item = order.items.find((i) => i.id === line.orderItemId);
          requireThat(
            item &&
              integer(line.quantity, 1) &&
              item.refundedQuantity + line.quantity <= item.quantity,
            "退款数量超出购买数量",
          );
          const expected =
            refundThrough(item, item.refundedQuantity + line.quantity) -
            refundThrough(item, item.refundedQuantity);
          requireThat(expected === line.amount, "退款分摊金额无效");
          amount += expected;
        }
        const shippingRefund = sale.shippingRefund ?? 0;
        requireThat(
          integer(shippingRefund) &&
            (!shippingRefund ||
              (!sale.requiresReturn &&
                shippingRefund ===
                  (order.shippingFee ?? 0) - (order.shippingRefunded ?? 0) &&
                order.items.every(
                  (item) =>
                    item.refundedQuantity +
                      (sale.lines.find((l) => l.orderItemId === item.id)
                        ?.quantity ?? 0) ===
                    item.quantity,
                ))),
          "运费退款金额无效",
        );
        amount += shippingRefund;
        requireThat(
          amount === sale.refundAmount &&
            order.refundedAmount + amount <= order.total,
          "退款金额超出实付金额",
        );
        for (const line of sale.lines) {
          const item = order.items.find((i) => i.id === line.orderItemId)!;
          if (!sale.requiresReturn || order.inventoryPolicy !== "reserved-v1")
            move(
              db,
              item.productId,
              item.skuId,
              line.quantity,
              `售后退款回补 ${order.id}`,
            );
          item.refundedQuantity += line.quantity;
        }
        ledger(db, "refund", amount, order.id, `模拟售后退款 ${sale.id}`);
        sale.status = "refunded";
        order.refundedAmount += amount;
        order.shippingRefunded = (order.shippingRefunded ?? 0) + shippingRefund;
        syncOrderPoints(db, order);
        if (order.items.every((i) => i.refundedQuantity === i.quantity))
          order.status = "refunded";
        addEvent(order, "refund", "admin", `退款 ${amount} 分`);
      }
      if (note.trim()) sale.note = note.trim();
      sale.events.push({
        at: now(),
        actor: "admin",
        action,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
    });
  },
};

export function addCartChange(
  db: Database,
  productId: string,
  skuId: string,
  quantity: number,
) {
  const uid = userId(),
    { product, sku } = productSku(db, productId, skuId);
  requireThat(product.active && integer(quantity, 1), "商品已下架或数量无效");
  const existing = db.carts.find(
    (c) => c.userId === uid && c.productId === productId && c.skuId === skuId,
  );
  requireThat(
    (existing?.quantity ?? 0) + quantity <=
      availableStock(db, product.id, sku.id),
    "库存不足",
  );
  if (existing) {
    existing.quantity += quantity;
    existing.selected = true;
  } else
    db.carts.push({
      id: id("cart-"),
      userId: uid,
      productId,
      skuId,
      quantity,
      selected: true,
    });
}

export function cancelOrderChange(db: Database, orderId: string) {
  const order = ownedOrder(db, orderId);
  if (order.status === "cancelled") return;
  requireThat(order.status === "pending", "只有待付款订单可以取消");
  order.status = "cancelled";
  order.cancelledAt = now();
  order.cancelReason = "用户取消";
  addEvent(order, "cancelled", "user", "用户取消");
  releaseCoupon(db, order);
}

export function requestAfterSaleChange(
  db: Database,
  orderId: string,
  reason: string,
  description: string,
  lines: { orderItemId: string; quantity: number }[],
) {
  const order = ownedOrder(db, orderId);
  requireThat(
    ["paid", "shipped", "completed"].includes(order.status),
    "该状态不能申请售后",
  );
  requireThat(
    !order.completedAt ||
      order.afterSaleDays === undefined ||
      Date.now() <=
        Date.parse(order.completedAt) + order.afterSaleDays * 86400000,
    "已超过该订单售后申请期限",
  );
  requireThat(
    text(reason, 100) && text(description, 1000),
    "请填写售后原因与说明",
  );
  requireThat(!hasSale(db, orderId), "该订单已有售后申请，请查看处理进度");
  requireThat(
    lines.length > 0 &&
      new Set(lines.map((l) => l.orderItemId)).size === lines.length,
    "请选择不重复的售后商品",
  );
  const details = lines.map((line) => {
    const item = order.items.find((i) => i.id === line.orderItemId);
    requireThat(
      item &&
        integer(line.quantity, 1) &&
        line.quantity <= item.quantity - item.refundedQuantity,
      "售后商品或数量无效，不能超过剩余可退数量",
    );
    return {
      ...line,
      amount:
        refundThrough(item, item.refundedQuantity + line.quantity) -
        refundThrough(item, item.refundedQuantity),
    };
  });
  const at = now();
  const fullRemaining = order.items.every(
    (item) =>
      item.refundedQuantity +
        (details.find((line) => line.orderItemId === item.id)?.quantity ??
          0) ===
      item.quantity,
  );
  const shippingRefund =
    order.status === "paid" && fullRemaining
      ? (order.shippingFee ?? 0) - (order.shippingRefunded ?? 0)
      : 0;
  db.afterSales.unshift({
    id: id("as-"),
    orderId,
    userId: userId(),
    reason: reason.trim(),
    description: description.trim(),
    status: "requested",
    requiresReturn: order.status !== "paid",
    createdAt: at,
    note: "",
    lines: details,
    shippingRefund,
    refundAmount: details.reduce((n, l) => n + l.amount, 0) + shippingRefund,
    events: [{ at, actor: "user", action: "requested" }],
  });
  addEvent(order, "afterSaleRequested", "user");
}
