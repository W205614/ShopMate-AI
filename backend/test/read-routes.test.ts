import { beforeEach, afterEach, describe, it, expect } from "vitest";
import type { Server } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase, writeDatabase } from "../src/database";
import { createApp } from "../src/app";
import { createSeed } from "../../shared/domain/seed";
import { tokenHash } from "../src/auth";

let sql: DatabaseSync, server: Server, base: string;
beforeEach(async () => {
  sql = openDatabase(":memory:");
  writeDatabase(sql, createSeed());
  for (const [id, role, token] of [
    ["u1", "user", "user-token"],
    ["admin", "admin", "admin-token"],
  ]) {
    sql
      .prepare("INSERT INTO accounts VALUES(?,?,?,?,?,?)")
      .run(id, id, id, role, "unused-test-hash", 1);
    sql
      .prepare("INSERT INTO sessions VALUES(?,?,?)")
      .run(tokenHash(token), id, Date.now() + 60000);
  }
  const app = await createApp(sql, { origins: ["http://localhost"] });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  sql.close();
});
async function get(path: string, admin = false) {
  const response = await fetch(base + path, {
    headers: {
      Cookie: admin ? "shopmate_admin=admin-token" : "shopmate_user=user-token",
    },
  });
  expect(response.status).toBe(200);
  return response.json();
}

describe("paged read contracts", () => {
  it("resolves nested conversation recommendations beyond bootstrap and only owned message orders", async () => {
    const seed = createSeed(),
      baseProduct = seed.products[0]!,
      ownOrder = seed.orders.find((order) => order.userId === "u1")!,
      foreignOrder = seed.orders.find((order) => order.userId === "u2")!;
    for (const product of seed.products) product.active = true;
    const recommendation = {
      ...structuredClone(baseProduct),
      id: "outside-bootstrap-25",
      name: "第25件推荐商品",
      skus: baseProduct.skus.map((sku, index) => ({
        ...sku,
        id: `outside-25-sku-${index}`,
        stock: 0,
      })),
    };
    seed.products.push(recommendation);
    ownOrder.status = "completed";
    ownOrder.completedAt = new Date().toISOString();
    foreignOrder.address = {
      ...foreignOrder.address,
      name: "FOREIGN_PRIVATE_RECIPIENT",
      phone: "13988887777",
    };
    seed.conversations = [
      {
        id: "nested-context",
        userId: "u1",
        title: "无顶层商品或订单",
        status: "bot",
        createdAt: new Date().toISOString(),
        messages: [
          {
            id: "recommendation-message",
            role: "assistant",
            text: "推荐商品",
            createdAt: new Date().toISOString(),
            productIds: [recommendation.id],
          },
          {
            id: "own-order-message",
            role: "assistant",
            text: "本人历史订单",
            createdAt: new Date().toISOString(),
            orderId: ownOrder.id,
          },
          {
            id: "foreign-order-message",
            role: "assistant",
            text: "不可访问的订单引用",
            createdAt: new Date().toISOString(),
            orderId: foreignOrder.id,
          },
        ],
      },
    ];
    writeDatabase(sql, seed);
    const boot = await get("/api/bootstrap");
    expect(
      boot.db.products.some(
        (product: { id: string }) => product.id === recommendation.id,
      ),
    ).toBe(false);
    expect(boot.db.orders).toHaveLength(0);
    const page = await get("/api/collections/conversations?id=nested-context");
    expect(
      page.related.products.some(
        (product: { id: string }) => product.id === recommendation.id,
      ),
    ).toBe(true);
    expect(
      page.related.orders.map((order: { id: string }) => order.id),
    ).toEqual([ownOrder.id]);
    expect(JSON.stringify(page)).not.toContain("FOREIGN_PRIVATE_RECIPIENT");
    expect(JSON.stringify(page)).not.toContain("13988887777");
    const support = await get(
      "/api/collections/conversations?role=admin&id=nested-context",
      true,
    );
    expect(
      support.related.products.some(
        (product: { id: string }) => product.id === recommendation.id,
      ),
    ).toBe(true);
    expect(
      support.related.orders.map((order: { id: string }) => order.id).sort(),
    ).toEqual([ownOrder.id, foreignOrder.id].sort());
  });
  it("attaches only real current-page ledger associations authorized for the employee", async () => {
    const seed = createSeed(),
      at = new Date().toISOString(),
      paymentOrder = seed.orders[0]!,
      refundOrder = seed.orders[1]!,
      purchaseCollision = seed.orders[2]!;
    const movement = { ...seed.inventory[0]!, id: "ledger-exact-movement" };
    seed.inventory.push(movement);
    seed.suppliers = [
      {
        id: "ledger-supplier",
        name: "ledger supplier",
        contact: "",
        active: true,
        version: 1,
      },
    ];
    seed.purchaseOrders = [
      {
        id: "ledger-linked-po",
        supplierId: "ledger-supplier",
        status: "received",
        createdAt: at,
        version: 1,
        lines: [
          {
            productId: movement.productId,
            skuId: movement.skuId,
            quantity: 1,
            unitCost: 25,
            received: 1,
          },
        ],
        receipts: [
          {
            id: "receipt-reference",
            createdAt: at,
            lines: [{ skuId: movement.skuId, quantity: 1 }],
            amount: 25,
            movementIds: [movement.id],
          },
        ],
      },
    ];
    seed.ledger = [
      {
        id: "ledger-payment",
        type: "payment",
        reference: paymentOrder.id,
        amount: 100,
        note: "payment",
        createdAt: at,
      },
      {
        id: "ledger-refund",
        type: "refund",
        reference: refundOrder.id,
        amount: 50,
        note: "refund",
        createdAt: at,
      },
      {
        id: "ledger-purchase",
        type: "purchase",
        reference: purchaseCollision.id,
        amount: 25,
        note: "purchase reference happens to match another order",
        createdAt: at,
        inventoryMovementId: movement.id,
      },
      {
        id: "ledger-missing",
        type: "purchase",
        reference: "receipt-with-missing-movement",
        amount: 10,
        note: "missing",
        createdAt: at,
        inventoryMovementId: "missing-movement",
      },
      {
        id: "ledger-receipt",
        type: "purchase",
        reference: "receipt-reference",
        amount: 25,
        note: "real receipt",
        createdAt: at,
        inventoryMovementId: movement.id,
      },
    ];
    writeDatabase(sql, seed);
    const page = await get(
      "/api/collections/ledger?role=admin&pageSize=100",
      true,
    );
    expect(
      page.related.orders.map((order: { id: string }) => order.id).sort(),
    ).toEqual([paymentOrder.id, refundOrder.id].sort());
    expect(page.related.orders[0]).toHaveProperty("address");
    expect(page.related.inventory.map((row: { id: string }) => row.id)).toEqual(
      [movement.id],
    );
    expect(
      page.related.products.some(
        (product: { id: string }) => product.id === movement.productId,
      ),
    ).toBe(true);
    const purchase = await get(
      "/api/collections/ledger?role=admin&id=ledger-purchase",
      true,
    );
    expect(purchase.related.orders ?? []).toEqual([]);
    expect(
      purchase.related.inventory.map((row: { id: string }) => row.id),
    ).toEqual([movement.id]);
    const payment = await get(
      "/api/collections/ledger?role=admin&id=ledger-payment",
      true,
    );
    expect(
      payment.related.orders.map((order: { id: string }) => order.id),
    ).toEqual([paymentOrder.id]);
    expect(payment.related.inventory).toEqual([]);
    const receipt = await get(
      "/api/collections/ledger?role=admin&id=ledger-receipt",
      true,
    );
    expect(receipt.related.orders ?? []).toEqual([]);
    expect(
      receipt.related.purchaseOrders.map(
        (purchase: { id: string }) => purchase.id,
      ),
    ).toEqual(["ledger-linked-po"]);
    expect(receipt.related.purchaseOrders[0].receipts[0].movementIds).toContain(
      movement.id,
    );
    sql
      .prepare("INSERT INTO accounts VALUES(?,?,?,?,?,?)")
      .run("finance", "finance", "财务", "admin", "unused-test-hash", 1);
    sql
      .prepare("INSERT INTO staff_access VALUES(?,?,?)")
      .run("finance", "finance", 1);
    sql
      .prepare("INSERT INTO sessions VALUES(?,?,?)")
      .run(tokenHash("finance-token"), "finance", Date.now() + 60000);
    const headers = { Cookie: "shopmate_admin=finance-token" },
      finance = await fetch(
        `${base}/api/collections/ledger?role=admin&pageSize=100`,
        { headers },
      );
    expect(finance.status).toBe(200);
    const body = await finance.json();
    expect(
      body.related.orders.map((order: { id: string }) => order.id).sort(),
    ).toEqual([paymentOrder.id, refundOrder.id].sort());
    expect(body.related.inventory).toBeUndefined();
    expect(body.related.purchaseOrders).toBeUndefined();
    expect(
      (await fetch(`${base}/api/collections/inventory?role=admin`, { headers }))
        .status,
    ).toBe(403);
  });
  it("filters expired and inactive public coupons before pagination while keeping future starts visible", async () => {
    const seed = createSeed(),
      at = Date.now();
    const coupon = (id: string, active = true, expired = false) => ({
      id,
      name: id,
      threshold: 100,
      discount: 10,
      totalLimit: 100,
      active,
      claimStartsAt: new Date(at - 86400000).toISOString(),
      claimEndsAt: new Date(
        at + (expired ? -86400000 : 86400000),
      ).toISOString(),
      validFrom: new Date(at - 86400000).toISOString(),
      validUntil: new Date(at + 7 * 86400000).toISOString(),
    });
    seed.coupons = [
      ...Array.from({ length: 105 }, (_, index) =>
        coupon(`z-expired-${index}`, true, true),
      ),
      coupon("z-inactive", false),
      coupon("a-visible"),
      coupon("a-visible-second"),
      {
        ...coupon("a-future"),
        claimStartsAt: new Date(at + 3600000).toISOString(),
      },
    ];
    writeDatabase(sql, seed);
    const first = await get("/api/collections/coupons?pageSize=2"),
      second = await get("/api/collections/coupons?pageSize=2&page=2");
    expect(first.total).toBe(3);
    expect(first.pages).toBe(2);
    expect(first.items).toHaveLength(2);
    expect(second.items).toHaveLength(1);
    expect(
      [...first.items, ...second.items]
        .map((row: { id: string }) => row.id)
        .sort(),
    ).toEqual(["a-future", "a-visible", "a-visible-second"]);
    const anonymous = await fetch(`${base}/api/collections/coupons?pageSize=2`);
    expect(anonymous.status).toBe(200);
    expect((await anonymous.json()).total).toBe(3);
    const admin = await get(
      "/api/collections/coupons?role=admin&id=z-inactive",
      true,
    );
    expect(admin.total).toBe(1);
    expect(admin.items[0].active).toBe(false);
    const expiredAdmin = await get(
      "/api/collections/coupons?role=admin&id=z-expired-0",
      true,
    );
    expect(expiredAdmin.total).toBe(1);
  });

  it("returns complete owner member totals and coupon context beyond bootstrap pages", async () => {
    const seed = createSeed(),
      at = Date.now(),
      ownerOrder = seed.orders.find((order) => order.userId === "u1")!,
      otherOrder = seed.orders.find((order) => order.userId === "u2")!;
    for (let index = 0; index < 105; index++) {
      const orderId = `owner-extra-${index}`;
      seed.orders.push({
        ...structuredClone(ownerOrder),
        id: orderId,
        items: ownerOrder.items.map((item, line) => ({
          ...item,
          id: `${orderId}-line-${line}`,
        })),
      });
    }
    seed.afterSales = Array.from({ length: 4 }, (_, index) => ({
      id: `member-after-${index}`,
      orderId: index === 3 ? otherOrder.id : ownerOrder.id,
      userId: index === 3 ? "u2" : "u1",
      status: "requested",
      requiresReturn: true,
      reason: "test",
      description: "",
      note: "",
      createdAt: new Date(at).toISOString(),
      refundAmount: 0,
      lines: [],
      events: [],
    }));
    seed.carts = [
      {
        id: "own-cart-one",
        userId: "u1",
        productId: "p01",
        skuId: "p01-s1",
        quantity: 2,
        selected: true,
      },
      {
        id: "own-cart-two",
        userId: "u1",
        productId: "p02",
        skuId: "p02-s1",
        quantity: 3,
        selected: false,
      },
      {
        id: "other-cart",
        userId: "u2",
        productId: "p01",
        skuId: "p01-s1",
        quantity: 7,
        selected: true,
      },
    ];
    seed.favorites = {
      u1: ["p01", "p02", "p03"],
      u2: seed.products.map((product) => product.id),
    };
    seed.coupons = Array.from({ length: 130 }, (_, index) => ({
      id: `coupon-${String(index).padStart(3, "0")}`,
      name: `coupon ${index}`,
      threshold: 100,
      discount: 10,
      totalLimit: 1000,
      active: index !== 5,
      claimStartsAt: new Date(at - 86400000).toISOString(),
      claimEndsAt: new Date(
        at + (index === 5 ? -86400000 : 86400000),
      ).toISOString(),
      validFrom: new Date(at - 86400000).toISOString(),
      validUntil: new Date(at + 86400000).toISOString(),
    }));
    seed.couponClaims = [
      ...Array.from({ length: 120 }, (_, index) => ({
        id:
          index === 5
            ? "z-history-claim"
            : `claim-${String(index).padStart(3, "0")}`,
        userId: "u1",
        couponId: seed.coupons[index]!.id,
        claimedAt: new Date(at).toISOString(),
        status: "available" as const,
      })),
      {
        id: "other-claim",
        userId: "u2",
        couponId: "coupon-010",
        claimedAt: new Date(at).toISOString(),
        status: "available",
      },
    ];
    writeDatabase(sql, seed);
    const boot = await get("/api/bootstrap");
    expect(boot.memberSummary).toEqual({
      orderCount: seed.orders.filter((order) => order.userId === "u1").length,
      afterSaleCount: 3,
      couponClaimCount: 120,
      favoriteCount: 3,
      cartQuantity: 5,
    });
    expect(boot.db.orders).toHaveLength(0);
    expect(boot.db.couponClaims).toHaveLength(100);
    expect(
      boot.db.coupons.some((row: { id: string }) => row.id === "coupon-005"),
    ).toBe(true);
    expect(
      boot.db.coupons.find((row: { id: string }) => row.id === "coupon-005")
        .active,
    ).toBe(false);
    expect(
      boot.db.couponClaims.some(
        (row: { couponId: string }) => row.couponId === "coupon-010",
      ),
    ).toBe(false);
    const wallet = await get(
      "/api/collections/couponClaims?id=z-history-claim",
    );
    expect(wallet.items).toHaveLength(1);
    expect(wallet.related.coupons[0].id).toBe("coupon-005");
    expect(wallet.related.coupons[0].active).toBe(false);
    const catalogue = await get("/api/collections/coupons?id=coupon-010");
    expect(catalogue.items).toHaveLength(1);
    expect(
      catalogue.related.couponClaims.map((row: { id: string }) => row.id),
    ).toEqual(["claim-010"]);
    expect(catalogue.items[0].claimedCount).toBe(2);
    const anonymous = await fetch(`${base}/api/bootstrap`);
    expect((await anonymous.json()).memberSummary).toBeNull();
  });
  it("redacts related order addresses and money for marketing staff even through review and coupon claim context", async () => {
    const seed = createSeed(),
      order = seed.orders[0]!,
      line = order.items[0]!;
    order.status = "completed";
    order.completedAt = new Date().toISOString();
    order.address = {
      ...order.address,
      name: "PRIVATE_RECIPIENT",
      phone: "13987654321",
      detail: "PRIVATE_ADDRESS",
    };
    seed.reviews = [
      {
        id: "marketing-review",
        userId: order.userId,
        orderId: order.id,
        orderItemId: line.id,
        productId: line.productId,
        rating: 5,
        content: "公开评价文本",
        createdAt: new Date().toISOString(),
        hidden: false,
        deleted: false,
      },
    ];
    seed.couponClaims = [
      {
        id: "marketing-claim",
        userId: order.userId,
        orderId: order.id,
        couponId: "historical-coupon",
        claimedAt: new Date().toISOString(),
        status: "used",
      },
    ];
    writeDatabase(sql, seed);
    sql
      .prepare("INSERT INTO accounts VALUES(?,?,?,?,?,?)")
      .run("operations", "operations", "运营", "admin", "unused-test-hash", 1);
    sql
      .prepare("INSERT INTO staff_access VALUES(?,?,?)")
      .run("operations", "operations", 1);
    sql
      .prepare("INSERT INTO sessions VALUES(?,?,?)")
      .run(tokenHash("operations-token"), "operations", Date.now() + 60000);
    const headers = { Cookie: "shopmate_admin=operations-token" };
    for (const collection of ["reviews", "couponClaims"]) {
      const response = await fetch(
        `${base}/api/collections/${collection}?role=admin`,
        { headers },
      );
      expect(response.status).toBe(200);
      const body = await response.json(),
        related = body.related.orders[0];
      expect(Object.keys(related).sort()).toEqual([
        "id",
        "items",
        "status",
        "userId",
      ]);
      expect(Object.keys(related.items[0]).sort()).toEqual([
        "id",
        "productId",
        "quantity",
        "refundedQuantity",
      ]);
      expect(JSON.stringify(body)).not.toContain("PRIVATE_RECIPIENT");
      expect(JSON.stringify(body)).not.toContain("PRIVATE_ADDRESS");
      expect(JSON.stringify(body)).not.toContain("13987654321");
      expect(related).not.toHaveProperty("total");
      expect(related).not.toHaveProperty("subtotal");
      expect(related).not.toHaveProperty("refundedAmount");
      expect(related).not.toHaveProperty("shippingFee");
      expect(
        body.related.products.some(
          (product: { id: string }) => product.id === line.productId,
        ),
      ).toBe(true);
    }
    expect(
      (await fetch(`${base}/api/collections/orders?role=admin`, { headers }))
        .status,
    ).toBe(403);
    const allowed = await get(
      `/api/collections/reviews?role=admin&id=marketing-review`,
      true,
    );
    expect(allowed.related.orders[0].address.name).toBe("PRIVATE_RECIPIENT");
    expect(allowed.related.orders[0].total).toBe(order.total);
  });
  it("locates a conversation on its global priority page and respects filters and ownership", async () => {
    const seed = createSeed(),
      statuses = ["waiting", "human", "bot", "closed"] as const;
    seed.conversations = Array.from({ length: 40 }, (_, index) => {
      const group = Math.floor(index / 10),
        status = statuses[group]!;
      return {
        id: `conversation-${String(index).padStart(2, "0")}`,
        userId: index === 39 ? "u2" : "u1",
        title: `${status} conversation ${index}`,
        status,
        messages: [],
        createdAt: `${2020 + group}-01-${String((index % 10) + 1).padStart(2, "0")}T00:00:00.000Z`,
      };
    });
    writeDatabase(sql, seed);
    const first = await get(
      "/api/collections/conversations?role=admin&pageSize=10",
      true,
    );
    expect(first.total).toBe(40);
    expect(
      first.items.every((row: { status: string }) => row.status === "waiting"),
    ).toBe(true);
    const second = await get(
      "/api/collections/conversations?role=admin&pageSize=10&page=2",
      true,
    );
    expect(
      second.items.every((row: { status: string }) => row.status === "human"),
    ).toBe(true);
    const located = await get(
      "/api/collections/conversations?role=admin&pageSize=10&locate=conversation-32",
      true,
    );
    expect(located.located).toBe(true);
    expect(located.page).toBe(4);
    expect(located.pages).toBe(4);
    expect(
      located.items.some((row: { id: string }) => row.id === "conversation-32"),
    ).toBe(true);
    const filtered = await get(
      "/api/collections/conversations?role=admin&pageSize=10&status=closed&locate=conversation-32",
      true,
    );
    expect(filtered.located).toBe(true);
    expect(filtered.total).toBe(10);
    expect(filtered.page).toBe(1);
    const excluded = await get(
      "/api/collections/conversations?role=admin&pageSize=10&search=waiting&locate=conversation-32",
      true,
    );
    expect(excluded.located).toBe(false);
    expect(excluded.total).toBe(10);
    expect(
      excluded.items.every(
        (row: { status: string }) => row.status === "waiting",
      ),
    ).toBe(true);
    const privateTarget = await get(
      "/api/collections/conversations?pageSize=10&locate=conversation-39",
    );
    expect(privateTarget.located).toBe(false);
    expect(privateTarget.total).toBe(39);
    expect(
      privateTarget.items.every(
        (row: { userId: string }) => row.userId === "u1",
      ),
    ).toBe(true);
  });
  it("moderates a completed purchase review through an idempotent admin command", async () => {
    const seed = createSeed(),
      order = seed.orders[0]!,
      line = order.items[0]!;
    order.status = "completed";
    order.completedAt = new Date().toISOString();
    seed.reviews = [
      {
        id: "moderate-completed",
        userId: order.userId,
        orderId: order.id,
        orderItemId: line.id,
        productId: line.productId,
        rating: 5,
        content: "这是一个购买后的评价",
        createdAt: new Date().toISOString(),
        hidden: false,
        deleted: false,
      },
    ];
    writeDatabase(sql, seed);
    const response = await fetch(base + "/api/actions/moderateReview", {
      method: "POST",
      headers: {
        Cookie: "shopmate_admin=admin-token",
        "Content-Type": "application/json",
        "X-ShopMate-Request": "1",
      },
      body: JSON.stringify({
        args: ["moderate-completed", true],
        requestId: "review-scoped-history",
      }),
    });
    expect(response.status).toBe(200);
    const page = await get(
      "/api/collections/reviews?role=admin&status=hidden",
      true,
    );
    expect(page.items.map((review: { id: string }) => review.id)).toEqual([
      "moderate-completed",
    ]);
  });
  it("maps admin active filters and domain numeric sorts before pagination", async () => {
    const seed = createSeed();
    seed.products[0]!.active = false;
    writeDatabase(sql, seed);
    const inactive = await get(
      "/api/collections/products?role=admin&status=false&pageSize=100",
      true,
    );
    expect(
      inactive.items.every((product: { active: boolean }) => !product.active),
    ).toBe(true);
    expect(inactive.total).toBe(
      seed.products.filter((product) => !product.active).length,
    );
    const ordered = await get(
      "/api/collections/products?role=admin&sort=asc&pageSize=2",
      true,
    );
    const prices = seed.products
      .map((product) => Math.min(...product.skus.map((sku) => sku.price)))
      .sort((a, b) => a - b)
      .slice(0, 2);
    expect(
      ordered.items.map((product: { skus: { price: number }[] }) =>
        Math.min(...product.skus.map((sku) => sku.price)),
      ),
    ).toEqual(prices);
    const categories = await get(
      "/api/collections/categories?role=admin&sort=desc&pageSize=2",
      true,
    );
    expect(
      categories.items.map((category: { sort: number }) => category.sort),
    ).toEqual(
      seed.categories
        .map((category) => category.sort)
        .sort((a, b) => b - a)
        .slice(0, 2),
    );
    const invalid = await fetch(
      `${base}/api/collections/ledger?role=admin&from=2026-99-99`,
      { headers: { Cookie: "shopmate_admin=admin-token" } },
    );
    expect(invalid.status).toBe(400);
  });

  it("pages inventory by SKU and filters low stock before calculating totals", async () => {
    const seed = createSeed(),
      skus = seed.products.flatMap((product) => product.skus);
    const page = await get(
      "/api/collections/products?role=admin&view=inventory&pageSize=7&page=2&sort=asc",
      true,
    );
    expect(page.total).toBe(skus.length);
    expect(
      page.items.flatMap((product: { skus: unknown[] }) => product.skus),
    ).toHaveLength(7);
    expect(
      page.items
        .flatMap((product: { skus: { stock: number }[] }) =>
          product.skus.map((sku) => sku.stock),
        )
        .sort((a: number, b: number) => a - b),
    ).toEqual(
      skus
        .map((sku) => sku.stock)
        .sort((a, b) => a - b)
        .slice(7, 14),
    );
    const low = await get(
      "/api/collections/products?role=admin&view=inventory&low=1&pageSize=100",
      true,
    );
    expect(low.total).toBe(skus.filter((sku) => sku.stock <= 5).length);
  });

  it("filters favorites beyond the first hundred IDs and keeps cart products in bootstrap", async () => {
    const seed = createSeed(),
      original = seed.products[0]!;
    seed.products = Array.from({ length: 120 }, (_, index) => ({
      ...structuredClone(original),
      id: `extra-${String(index).padStart(3, "0")}`,
      skus: original.skus.map((sku) => ({ ...sku, id: `${index}-${sku.id}` })),
    }));
    seed.favorites.u1 = seed.products.map((product) => product.id);
    const last = seed.products.at(-1)!;
    last.active = false;
    seed.carts = [
      {
        id: "outside-initial-catalogue",
        userId: "u1",
        productId: last.id,
        skuId: last.skus[0]!.id,
        quantity: 1,
        selected: true,
      },
    ];
    writeDatabase(sql, seed);
    const favorite = await get(
      "/api/collections/products?favorites=1&pageSize=10&page=11",
    );
    expect(favorite.total).toBe(120);
    expect(favorite.items).toHaveLength(10);
    const boot = await get("/api/bootstrap");
    expect(
      boot.db.products.some(
        (product: { id: string }) => product.id === last.id,
      ),
    ).toBe(true);
    const normalized = await get(
      "/api/collections/products?search=标准版%20静听&pageSize=10",
    );
    expect(normalized.total).toBe(119);
  });

  it("attaches only the page orders' own after-sales records", async () => {
    const seed = createSeed(),
      order = seed.orders.find((value) => value.userId === "u1")!;
    seed.afterSales = [
      {
        id: "page-sale",
        orderId: order.id,
        userId: "u1",
        status: "requested",
        reason: "return",
        description: "",
        requiresReturn: true,
        createdAt: new Date().toISOString(),
        note: "",
        lines: [],
        refundAmount: 0,
        events: [],
      },
    ];
    writeDatabase(sql, seed);
    const page = await get(`/api/collections/orders?id=${order.id}`);
    expect(
      page.related.afterSales.map((sale: { id: string }) => sale.id),
    ).toEqual(["page-sale"]);
    const privatePage = await get(
      `/api/collections/orders?id=${seed.orders.find((value) => value.userId !== "u1")!.id}`,
    );
    expect(privatePage.total).toBe(0);
    expect(privatePage.related.afterSales ?? []).toEqual([]);
  });
});
