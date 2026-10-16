import type { ShopApi } from "./api";
import {
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

export const commerceApi: Pick<
  ShopApi,
  | "addCart"
  | "updateCart"
  | "removeCart"
  | "favorite"
  | "saveAddress"
  | "deleteAddress"
  | "createOrder"
  | "payOrder"
  | "cancelOrder"
  | "confirmOrder"
  | "requestAfterSale"
  | "shipOrder"
  | "processAfterSale"
> = {
  async addCart(productId, skuId, quantity) {
    await transact((db) => {
      const uid = userId(),
        { product, sku } = productSku(db, productId, skuId);
      requireThat(
        product.active && integer(quantity, 1),
        "商品已下架或数量无效",
      );
      const existing = db.carts.find(
        (c) =>
          c.userId === uid && c.productId === productId && c.skuId === skuId,
      );
      requireThat(
        (existing?.quantity ?? 0) + quantity <= sku.stock,
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
    });
  },
  async updateCart(cartId, patch) {
    await transact((db) => {
      const item = db.carts.find(
        (c) => c.id === cartId && c.userId === userId(),
      );
      requireThat(item, "购物车条目不存在");
      if (patch.quantity !== undefined) {
        const { sku } = productSku(db, item.productId, item.skuId);
        requireThat(
          integer(patch.quantity, 1) && patch.quantity <= sku.stock,
          "数量必须为正整数且不能超过库存",
        );
        item.quantity = patch.quantity;
      }
      if (patch.selected !== undefined) item.selected = patch.selected;
    });
  },
  async removeCart(cartId) {
    await transact((db) => {
      const uid = userId();
      db.carts = db.carts.filter((c) => !(c.id === cartId && c.userId === uid));
    });
  },
  async favorite(productId) {
    await transact((db) => {
      const uid = userId();
      requireThat(
        db.products.some((p) => p.id === productId && p.active),
        "商品不存在或已下架",
      );
      const favorites = db.favorites[uid] ?? [];
      db.favorites[uid] = favorites.includes(productId)
        ? favorites.filter((p) => p !== productId)
        : [...favorites, productId];
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
      if (input.isDefault)
        db.addresses
          .filter((a) => a.userId === uid)
          .forEach((a) => {
            a.isDefault = false;
          });
      const value = {
        ...input,
        id: existing?.id ?? id("addr-"),
        userId: uid,
        isDefault:
          input.isDefault || !db.addresses.some((a) => a.userId === uid),
      };
      if (existing) Object.assign(existing, value);
      else db.addresses.push(value);
    });
  },
  async deleteAddress(addressId) {
    await transact((db) => {
      const uid = userId();
      db.addresses = db.addresses.filter(
        (a) => !(a.id === addressId && a.userId === uid),
      );
      if (!db.addresses.some((a) => a.userId === uid && a.isDefault)) {
        const first = db.addresses.find((a) => a.userId === uid);
        if (first) first.isDefault = true;
      }
    });
  },
  async createOrder(addressId) {
    return transact((db) => {
      const uid = userId(),
        selected = db.carts.filter((c) => c.userId === uid && c.selected);
      const address = db.addresses.find(
        (a) => a.id === addressId && a.userId === uid,
      );
      requireThat(address, "请选择自己的有效收货地址");
      requireThat(selected.length, "请先选择要结算的商品");
      const items = selected.map((c) => {
        const { product, sku } = productSku(db, c.productId, c.skuId);
        requireThat(
          product.active && integer(c.quantity, 1) && c.quantity <= sku.stock,
          `${product.name}已下架或库存不足，请返回购物车调整`,
        );
        return {
          productId: product.id,
          skuId: sku.id,
          name: product.name,
          skuName: sku.name,
          image: product.images[0]!,
          price: sku.price,
          quantity: c.quantity,
        };
      });
      const orderId = id("SM");
      const total = items.reduce(
        (sum, item) => sum + item.price * item.quantity,
        0,
      );
      requireThat(integer(total, 1), "订单金额无效");
      db.orders.unshift({
        id: orderId,
        userId: uid,
        items,
        total,
        status: "pending",
        address: clone(address),
        createdAt: now(),
      });
      db.carts = db.carts.filter((c) => !selected.some((s) => s.id === c.id));
      return orderId;
    });
  },
  async payOrder(orderId) {
    await transact((db) => {
      const order = ownedOrder(db, orderId);
      if (["paid", "shipped", "completed", "refunded"].includes(order.status))
        return;
      requireThat(order.status === "pending", "当前订单不能付款");
      for (const item of order.items) {
        const { product, sku } = productSku(db, item.productId, item.skuId);
        requireThat(
          product.active && sku.stock >= item.quantity,
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
      order.status = "paid";
      order.paidAt = now();
      ledger(db, "payment", order.total, order.id, "模拟订单收款");
    });
  },
  async cancelOrder(orderId) {
    await transact((db) => {
      const order = ownedOrder(db, orderId);
      if (order.status === "cancelled") return;
      requireThat(order.status === "pending", "只有待付款订单可以取消");
      order.status = "cancelled";
    });
  },
  async confirmOrder(orderId) {
    await transact((db) => {
      const order = ownedOrder(db, orderId);
      if (order.status === "completed") return;
      requireThat(order.status === "shipped", "只有待收货订单可以确认收货");
      requireThat(
        !db.afterSales.some(
          (a) =>
            a.orderId === orderId &&
            !["rejected", "refunded"].includes(a.status),
        ),
        "售后处理中，暂不能确认收货",
      );
      order.status = "completed";
    });
  },
  async requestAfterSale(orderId, reason, description) {
    await transact((db) => {
      const order = ownedOrder(db, orderId);
      requireThat(
        ["paid", "shipped", "completed"].includes(order.status),
        "该状态不能申请售后",
      );
      requireThat(
        text(reason, 100) && text(description, 1000),
        "请填写售后原因与说明",
      );
      requireThat(
        !db.afterSales.some(
          (a) => a.orderId === orderId && a.status !== "rejected",
        ),
        "该订单已有售后申请，请查看处理进度",
      );
      db.afterSales.unshift({
        id: id("as-"),
        orderId,
        userId: userId(),
        reason: reason.trim(),
        description: description.trim(),
        status: "requested",
        requiresReturn: order.status !== "paid",
        createdAt: now(),
        note: "",
      });
    });
  },
  async shipOrder(orderId, carrier, tracking) {
    await transact((db) => {
      admin();
      const order = db.orders.find((o) => o.id === orderId);
      requireThat(order, "订单不存在");
      requireThat(order.status === "paid", "只有待发货订单可以发货");
      requireThat(
        !db.afterSales.some(
          (a) => a.orderId === orderId && a.status !== "rejected",
        ),
        "售后处理中，不能发货",
      );
      requireThat(
        text(carrier, 60) && text(tracking, 80),
        "请填写物流公司与单号",
      );
      order.status = "shipped";
      order.carrier = carrier.trim();
      order.tracking = tracking.trim();
      order.shippedAt = now();
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
          sale.requiresReturn && sale.status === "approved",
          "只有已批准的退货申请可以记录收货",
        );
        sale.status = "received";
      } else {
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
        for (const item of order.items)
          move(
            db,
            item.productId,
            item.skuId,
            item.quantity,
            `售后退款回补 ${order.id}`,
          );
        ledger(db, "refund", order.total, order.id, "模拟售后退款");
        sale.status = "refunded";
        order.status = "refunded";
      }
      if (note.trim()) sale.note = note.trim();
    });
  },
};
