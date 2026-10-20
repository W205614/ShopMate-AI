import { expect, it } from "vitest";
import { openDatabase, readDatabase, writeDatabase } from "../src/database";
import { createApp } from "../src/app";
import { createSeed } from "../../shared/domain/seed";

it("bootstrap and paginated reads isolate new member records and hide warehouse data from both customers", async () => {
  const sql = openDatabase(":memory:");
  const app = await createApp(sql, { origins: ["http://localhost"] });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.on("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const users = await Promise.all(
      ["first", "second"].map(async (name) => {
        const response = await fetch(base + "/api/auth/register", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-ShopMate-Request": "1",
          },
          body: JSON.stringify({
            username: name,
            name,
            password: "PrivacyTest123!",
          }),
        });
        expect(response.status).toBe(201);
        return {
          id: (await response.json()).id as string,
          cookie: response.headers.get("set-cookie")!.split(";")[0]!,
        };
      }),
    );
    const db = readDatabase(sql),
      at = new Date().toISOString();
    for (const [index, user] of users.entries()) {
      const order = structuredClone(createSeed().orders[5]!);
      order.id = `private-order-${index}`;
      order.userId = user.id;
      order.address.userId = user.id;
      order.items = order.items.map((item) => ({
        ...item,
        id: `${order.id}-item`,
      }));
      db.orders.push(order);
    }
    db.notifications = users.map((user, index) => ({
      id: `notification-${index}`,
      userId: user.id,
      orderId: `private-order-${index}`,
      text: `private-notice-${index}`,
      read: false,
      createdAt: at,
    }));
    db.pointsEntries = users.map((user, index) => ({
      id: `points-${index}`,
      userId: user.id,
      orderId: `private-order-${index}`,
      delta: index + 1,
      reason: `private-points-${index}`,
      createdAt: at,
    }));
    db.suppliers = [
      {
        id: "supplier",
        name: "internal supplier",
        contact: "private purchasing contact",
        active: true,
        version: 1,
      },
    ];
    db.purchaseOrders = [
      {
        id: "purchase",
        supplierId: "supplier",
        status: "draft",
        lines: [],
        receipts: [],
        createdAt: at,
        version: 1,
      },
    ];
    db.returnInspections = [
      {
        id: "inspection",
        afterSaleId: "historical-sale",
        orderItemId: db.orders[0]!.items[0]!.id,
        productId: "p01",
        skuId: "p01-s1",
        quantity: 1,
        good: 0,
        defective: 0,
        disposed: 0,
        status: "pending",
        note: "private inspection",
        createdAt: at,
        version: 1,
      },
    ];
    writeDatabase(sql, db);
    for (const user of [undefined, ...users]) {
      const headers = user ? { Cookie: user.cookie } : undefined;
      const bootstrap = await (await fetch(base + "/api/bootstrap", { headers })).json();
      for (const collection of ["notifications", "pointsEntries", "suppliers", "purchaseOrders", "returnInspections", "auditEntries", "shippingRules"])
        expect(bootstrap.db[collection]).toEqual([]);
      if (user) {
        for (const collection of ["notifications", "pointsEntries"]) {
          const modern = await (
            await fetch(base + `/api/collections/${collection}?role=user`, {
              headers,
            })
          ).json();
          expect(
            modern.items.map((row: { userId: string }) => row.userId),
          ).toEqual([user.id]);
        }
        expect(
          (
            await fetch(base + "/api/collections/suppliers?role=user", {
              headers,
            })
          ).status,
        ).toBe(403);
      }
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    sql.close();
  }
});
