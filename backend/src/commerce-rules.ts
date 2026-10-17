import type {
  Database,
  Order,
  OrderItem,
  CheckoutInput,
} from "../../shared/domain/types";
import { requireThat, productSku, integer, clone, now } from "./repository";

export const activeAfterSale = (status: string) =>
  !["rejected", "refunded", "cancelled"].includes(status);
export function releaseCoupon(db: Database, order: Order) {
  const claim = db.couponClaims.find(
    (c) => c.id === order.coupon?.claimId && c.orderId === order.id,
  );
  if (claim?.status === "locked") {
    claim.status = "available";
    delete claim.orderId;
  }
}
export function expireOrders(db: Database, at = now()) {
  let changed = false;
  for (const order of db.orders) {
    if (
      order.status === "pending" &&
      order.expiresAt &&
      order.expiresAt <= at
    ) {
      order.status = "cancelled";
      order.cancelledAt = at;
      order.cancelReason = "付款超时";
      order.events.push({
        at,
        actor: "system",
        action: "cancelled",
        note: "付款超时",
      });
      releaseCoupon(db, order);
      changed = true;
    }
  }
  const quotes = db.checkoutQuotes.filter((q) => q.orderId || q.expiresAt > at);
  const requests = db.orderRequests.filter(
    (r) => Date.parse(r.createdAt) + 86400000 > Date.parse(at),
  );
  const inventoryRequests = db.inventoryRequests.filter(
    (r) => Date.parse(r.createdAt) + 86400000 > Date.parse(at),
  );
  if (
    quotes.length !== db.checkoutQuotes.length ||
    requests.length !== db.orderRequests.length ||
    inventoryRequests.length !== db.inventoryRequests.length
  )
    changed = true;
  db.checkoutQuotes = quotes;
  db.orderRequests = requests;
  db.inventoryRequests = inventoryRequests;
  return changed;
}
export function allocateDiscount(items: OrderItem[], discount: number) {
  const subtotal = items.reduce((n, i) => n + i.price * i.quantity, 0);
  requireThat(
    integer(subtotal, 1) && integer(discount) && discount < subtotal,
    "订单金额无效",
  );
  const divisor = BigInt(subtotal);
  const shares = items.map((item, index) => {
    const value = BigInt(item.price) * BigInt(item.quantity) * BigInt(discount);
    return {
      index,
      share: Number(value / divisor),
      remainder: value % divisor,
    };
  });
  let remaining = discount - shares.reduce((n, s) => n + s.share, 0);
  const ranked = [...shares].sort((a, b) =>
    a.remainder === b.remainder
      ? a.index - b.index
      : a.remainder > b.remainder
        ? -1
        : 1,
  );
  for (const share of ranked) if (remaining-- > 0) share.share++;
  for (const share of shares) {
    const item = items[share.index]!;
    item.discount = share.share;
    item.total = item.price * item.quantity - share.share;
  }
}
export function checkoutSnapshot(
  db: Database,
  uid: string,
  input: CheckoutInput,
) {
  const address = db.addresses.find(
    (a) => a.userId === uid && a.id === input.addressId,
  );
  requireThat(address, "请选择自己的有效收货地址");
  let entries: { productId: string; skuId: string; quantity: number }[];
  let cartState: unknown;
  if (input.source.type === "cart") {
    const ids = input.source.cartIds;
    requireThat(
      ids.length > 0 && new Set(ids).size === ids.length,
      "请选择要结算的购物车条目",
    );
    const carts = ids.map((cartId) =>
      db.carts.find((c) => c.id === cartId && c.userId === uid),
    );
    requireThat(
      carts.every((c) => !!c),
      "购物车条目已变化，请重新确认",
    );
    entries = carts.map((c) => c!);
    cartState = carts;
  } else entries = [input.source];
  const items = entries.map((entry, index): OrderItem => {
    const { product, sku } = productSku(db, entry.productId, entry.skuId);
    requireThat(
      product.active &&
        integer(entry.quantity, 1) &&
        entry.quantity <= sku.stock,
      `${product.name}已下架或库存不足，请重新确认`,
    );
    return {
      id: `line-${index + 1}`,
      productId: product.id,
      skuId: sku.id,
      name: product.name,
      skuName: sku.name,
      image: product.images[0]!,
      price: sku.price,
      quantity: entry.quantity,
      discount: 0,
      total: sku.price * entry.quantity,
      refundedQuantity: 0,
    };
  });
  const subtotal = items.reduce(
    (sum, item) => sum + item.price * item.quantity,
    0,
  );
  requireThat(integer(subtotal, 1), "订单金额无效");
  let coupon: { claimId: string; name: string; discount: number } | undefined;
  let couponState: unknown;
  if (input.couponClaimId) {
    const claim = db.couponClaims.find(
      (c) => c.id === input.couponClaimId && c.userId === uid,
    );
    const template = db.coupons.find((c) => c.id === claim?.couponId);
    const at = now();
    requireThat(
      claim?.status === "available" &&
        template?.active &&
        Date.parse(template.validFrom) <= Date.parse(at) &&
        Date.parse(template.validUntil) > Date.parse(at) &&
        subtotal >= template.threshold,
      "优惠券不可用、未达门槛或已过期",
    );
    requireThat(
      integer(template.discount, 1) && template.discount < template.threshold,
      "优惠券金额无效",
    );
    coupon = {
      claimId: claim.id,
      name: template.name,
      discount: Math.min(template.discount, subtotal - 1),
    };
    couponState = { claim, template };
  }
  const discount = coupon?.discount ?? 0;
  allocateDiscount(items, discount);
  // Stock is verified each time, but unrelated stock sales do not invalidate a quote.
  const fingerprint = JSON.stringify({
    input,
    items,
    address,
    cartState,
    couponState,
  });
  return {
    items,
    address: clone(address),
    subtotal,
    discount,
    total: subtotal - discount,
    coupon,
    fingerprint,
  };
}
export const refundThrough = (item: OrderItem, quantity: number) =>
  Number((BigInt(item.total) * BigInt(quantity)) / BigInt(item.quantity));
