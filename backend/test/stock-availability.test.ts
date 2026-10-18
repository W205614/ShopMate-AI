import { afterEach, beforeEach, expect, it } from "vitest";
import type { Server } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase, writeDatabase } from "../src/database";
import { createApp } from "../src/app";
import { tokenHash } from "../src/auth";
import { createSeed } from "../../shared/domain/seed";

let sql: DatabaseSync, server: Server, base: string;
beforeEach(async () => {
  sql = openDatabase(":memory:");
  const seed = createSeed(),
    product = seed.products[0]!,
    order = seed.orders[0]!,
    originalItem = order.items[0]!;
  const cases = [
    {
      id: "live-a",
      stock: 10,
      quantity: 8,
      policy: true,
      status: "pending",
      expires: true,
    },
    {
      id: "live-b",
      stock: 12,
      quantity: 8,
      policy: true,
      status: "pending",
      expires: true,
    },
    {
      id: "physical-low",
      stock: 3,
      quantity: 0,
      policy: true,
      status: "pending",
      expires: true,
    },
    {
      id: "expired",
      stock: 10,
      quantity: 8,
      policy: true,
      status: "pending",
      expires: false,
    },
    {
      id: "cancelled",
      stock: 10,
      quantity: 8,
      policy: true,
      status: "cancelled",
      expires: true,
    },
    {
      id: "legacy",
      stock: 10,
      quantity: 8,
      policy: false,
      status: "pending",
      expires: true,
    },
    {
      id: "paid",
      stock: 10,
      quantity: 8,
      policy: true,
      status: "paid",
      expires: true,
    },
    {
      id: "no-deadline",
      stock: 10,
      quantity: 8,
      policy: true,
      status: "pending",
      expires: undefined,
    },
  ] as const;
  product.skus = cases.map((entry) => ({
    ...product.skus[0]!,
    id: entry.id,
    name: entry.id,
    stock: entry.stock,
  }));
  seed.products = [product];
  seed.orders = cases
    .filter((entry) => entry.quantity)
    .map((entry) => ({
      ...structuredClone(order),
      id: `reservation-${entry.id}`,
      status: entry.status,
      inventoryPolicy: entry.policy ? "reserved-v1" : undefined,
      expiresAt:
        entry.expires === undefined
          ? undefined
          : new Date(
              Date.now() + (entry.expires ? 3600000 : -3600000),
            ).toISOString(),
      items: [
        {
          ...structuredClone(originalItem),
          id: `item-${entry.id}`,
          productId: product.id,
          skuId: entry.id,
          quantity: entry.quantity,
          refundedQuantity: 0,
        },
      ],
    }));
  writeDatabase(sql, seed);
  sql
    .prepare("INSERT INTO accounts VALUES(?,?,?,?,?,?)")
    .run("admin", "admin", "admin", "admin", "unused-test-hash", 1);
  sql
    .prepare("INSERT INTO sessions VALUES(?,?,?)")
    .run(tokenHash("admin-token"), "admin", Date.now() + 60000);
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
async function get(path: string) {
  const response = await fetch(base + path, {
    headers: { Cookie: "shopmate_admin=admin-token" },
  });
  expect(response.status).toBe(200);
  return response.json();
}

it("filters and pages by sellable stock while preserving physical stock and ignoring inactive reservations", async () => {
  const path =
    "/api/collections/products?role=admin&view=inventory&low=1&sort=asc&pageSize=2";
  const first = await get(path);
  expect(first).toMatchObject({ total: 3, pages: 2, page: 1 });
  expect(first.items[0].skus.map((sku: { id: string }) => sku.id)).toEqual([
    "live-a",
    "physical-low",
  ]);
  expect(first.items[0].skus[0]).toMatchObject({ stock: 10, reserved: 8 });
  const second = await get(`${path}&page=2`);
  expect(second).toMatchObject({ total: 3, pages: 2, page: 2 });
  expect(second.items[0].skus).toMatchObject([
    { id: "live-b", stock: 12, reserved: 8 },
  ]);
  const descending = await get(path.replace("sort=asc", "sort=desc"));
  expect(descending.items[0].skus.map((sku: { id: string }) => sku.id)).toEqual(
    ["live-b", "physical-low"],
  );
  const dashboard = await get("/api/admin/dashboard");
  expect(dashboard.lowStock.map((sku: { skuId: string }) => sku.skuId)).toEqual(
    ["live-a", "physical-low", "live-b"],
  );
  expect(dashboard.lowStock[0]).toMatchObject({
    stock: 10,
    reserved: 8,
    available: 2,
  });
  expect(dashboard.lowStock[2]).toMatchObject({
    stock: 12,
    reserved: 8,
    available: 4,
  });
});
