import { expect, it } from "vitest";
import { createApp } from "../src/app";
import { createAccount } from "../src/auth";
import { openDatabase, readDatabase, writeDatabase } from "../src/database";
import { createSeed } from "../../shared/domain/seed";
import { reconcile } from "../src/operations";

it("keyed review moderation loads its completed purchase rather than only pending orders", async () => {
  const sql = openDatabase(":memory:");
  writeDatabase(sql, createSeed());
  await createAccount(
    sql,
    { username: "moderator", name: "审核员", password: "ModeratorTest123!" },
    "admin",
  );
  const db = readDatabase(sql),
    order = db.orders.find((o) => o.status === "completed")!,
    item = order.items[0]!;
  db.reviews.push({
    id: "completed-purchase-review",
    userId: order.userId,
    orderId: order.id,
    orderItemId: item.id,
    productId: item.productId,
    rating: 5,
    content: "完成购买后的真实评价",
    createdAt: new Date().toISOString(),
    hidden: false,
    deleted: false,
  });
  writeDatabase(sql, db);
  const app = await createApp(sql, { origins: ["http://localhost"] });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.on("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-ShopMate-Request": "1",
  };
  try {
    const login = await fetch(base + "/api/auth/login", {
      method: "POST",
      headers,
      body: JSON.stringify({
        username: "moderator",
        password: "ModeratorTest123!",
        role: "admin",
      }),
    });
    expect(login.status).toBe(200);
    headers.Cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const body = JSON.stringify({
      args: ["completed-purchase-review", true],
      requestId: "hide-completed-review",
    });
    const action = () =>
      fetch(base + "/api/actions/moderateReview", {
        method: "POST",
        headers,
        body,
      });
    const response = await action();
    expect(response.status, await response.text()).toBe(200);
    const first = readDatabase(sql);
    expect(first.reviews[0]!.hidden).toBe(true);
    expect((await action()).status).toBe(200);
    expect(readDatabase(sql)).toEqual(first);
    const restore = await fetch(base + "/api/actions/moderateReview", {
      method: "POST",
      headers,
      body: JSON.stringify({
        args: ["completed-purchase-review", false],
        requestId: "restore-completed-review",
      }),
    });
    expect(restore.status, await restore.text()).toBe(200);
    expect(readDatabase(sql).reviews[0]!.hidden).toBe(false);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    sql.close();
  }
});

it("inventory reconciliation sums integer movements exactly regardless of stored history order", () => {
  const db = createSeed();
  db.orders = [];
  db.ledger = [];
  const product = db.products[0]!,
    sku = product.skus[0]!;
  db.products = [{ ...product, skus: [{ ...sku, stock: 2 }] }];
  // Every persisted value fits a safe integer; intermediate aggregation must use bigint.
  db.inventory = [Number.MAX_SAFE_INTEGER, 2, -Number.MAX_SAFE_INTEGER].map(
    (delta, index) => ({
      id: `boundary-${index}`,
      productId: product.id,
      skuId: sku.id,
      delta,
      reason: "historical aggregation boundary",
      createdAt: new Date().toISOString(),
    }),
  );
  expect(reconcile(db)).toMatchObject({ balanced: true, issues: [] });
});
