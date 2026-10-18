import { expect, it } from "vitest";
import { createApp } from "../src/app";
import { createAccount } from "../src/auth";
import { openDatabase, readDatabase, writeDatabase } from "../src/database";
import { createSeed } from "../../shared/domain/seed";
import type { AfterSale, Order, Review } from "../../shared/domain/types";
import { reviewWriteReason } from "../../frontend/src/domain/reviewWriteState";

it("each order page carries all own review and after-sale eligibility context without independently paginating it", async () => {
  const sql = openDatabase(":memory:");
  const app = await createApp(sql, { origins: ["http://localhost"] });
  const user = await createAccount(sql, {
    username: "reviewbuyer",
    name: "评价买家",
    password: "ReviewContext123!",
  });
  const warehouse = await createAccount(
    sql,
    { username: "warehouse", name: "仓储", password: "ReviewContext123!" },
    "admin",
  );
  sql
    .prepare("INSERT INTO staff_access VALUES (?,'warehouse',1)")
    .run(warehouse.id);
  const db = readDatabase(sql),
    template = createSeed().orders[0]!,
    at = new Date().toISOString();
  db.users.push({
    id: "other-user",
    username: "historical-other",
    name: "其他买家",
  });
  const sku = db.products.find((product) => product.id === "p01")!.skus[0]!;
  sku.stock += 100;
  db.inventory.push({
    id: "context-opening",
    productId: "p01",
    skuId: sku.id,
    delta: 100,
    reason: "历史测试期初",
    createdAt: at,
  });
  for (let index = 0; index < 13; index++) {
    const owner = index === 12 ? "other-user" : user.id,
      orderId = `context-order-${String(index).padStart(2, "0")}`;
    const order: Order = {
      ...structuredClone(template),
      id: orderId,
      userId: owner,
      items: Array.from({ length: 4 }, (_, line) => ({
        ...structuredClone(template.items[0]!),
        id: `${orderId}-line-${line}`,
      })),
      address: { ...template.address, userId: owner },
      createdAt: new Date(Date.now() - index * 1000).toISOString(),
      completedAt: at,
    };
    order.subtotal = order.total = order.items.reduce(
      (sum, item) => sum + item.total,
      0,
    );
    db.orders.push(order);
    sku.stock -= 4;
    db.inventory.push({
      id: `movement-${orderId}`,
      productId: "p01",
      skuId: sku.id,
      delta: -4,
      reason: `订单付款 ${orderId}`,
      createdAt: at,
    });
    db.ledger.push({
      id: `payment-${orderId}`,
      type: "payment",
      amount: order.total,
      reference: orderId,
      note: "历史测试付款",
      createdAt: at,
    });
    for (let line = 0; line < 3; line++)
      db.reviews.push({
        id: `${orderId}-review-${line}`,
        userId: owner,
        orderId,
        orderItemId: order.items[line]!.id,
        productId: "p01",
        rating: 5,
        content: "已经购买并评价的商品",
        hidden: line === 1,
        deleted: line === 2,
        createdAt: at,
      });
    for (const status of ["requested", "cancelled"] as const)
      db.afterSales.push({
        id: `${orderId}-sale-${status}`,
        orderId,
        userId: owner,
        reason: "历史售后",
        description: "资格上下文测试",
        status,
        requiresReturn: true,
        createdAt: at,
        note: "",
        lines: [
          {
            orderItemId: order.items[3]!.id,
            quantity: 1,
            amount: order.items[3]!.total,
          },
        ],
        refundAmount: order.items[3]!.total,
        events: [],
      });
  }
  writeDatabase(sql, db);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.on("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  async function login(role: "user" | "admin", username: string) {
    const response = await fetch(base + "/api/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-ShopMate-Request": "1",
      },
      body: JSON.stringify({ role, username, password: "ReviewContext123!" }),
    });
    expect(response.status).toBe(200);
    return response.headers.get("set-cookie")!.split(";")[0]!;
  }
  try {
    const cookie = await login("user", "reviewbuyer");
    for (const [page, count] of [
      [1, 10],
      [2, 2],
    ]) {
      const response = await fetch(
        base + `/api/collections/orders?role=user&page=${page}&pageSize=10`,
        { headers: { Cookie: cookie } },
      );
      expect(response.status).toBe(200);
      const result = (await response.json()) as {
        items: Order[];
        total: number;
        related: { reviews: Review[]; afterSales: AfterSale[] };
      };
      expect(result.total).toBe(12);
      expect(result.items).toHaveLength(count!);
      expect(result.related.reviews).toHaveLength(count! * 3);
      expect(result.related.afterSales).toHaveLength(count! * 2);
      const ids = new Set(result.items.map((order) => order.id));
      for (const record of [
        ...result.related.reviews,
        ...result.related.afterSales,
      ]) {
        expect(record.userId).toBe(user.id);
        expect(ids.has(record.orderId)).toBe(true);
      }
      for (const order of result.items) {
        for (const line of order.items.slice(0, 3))
          expect(
            reviewWriteReason(
              order,
              line,
              result.related.reviews,
              result.related.afterSales,
            ),
          ).toBe("已评价，不能重复评价");
        expect(
          reviewWriteReason(
            order,
            order.items[3],
            result.related.reviews,
            result.related.afterSales,
          ),
        ).toBe("售后处理中，暂不可评价");
      }
    }
    const warehouseCookie = await login("admin", "warehouse");
    const warehouseResult = await (
      await fetch(base + "/api/collections/orders?role=admin&pageSize=10", {
        headers: { Cookie: warehouseCookie },
      })
    ).json();
    expect(warehouseResult.related.reviews ?? []).toEqual([]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    sql.close();
  }
});
