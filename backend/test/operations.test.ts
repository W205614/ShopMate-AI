import { beforeEach, afterEach, describe, it, expect } from "vitest";
import type { Server } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase, readDatabase, writeDatabase } from "../src/database";
import { createApp } from "../src/app";
import { createAccount } from "../src/auth";
let sql: DatabaseSync, server: Server, base: string, cookie: string;
const headers = {
  "Content-Type": "application/json",
  "X-ShopMate-Request": "1",
};
async function post(path: string, body: unknown, auth = cookie) {
  return fetch(base + path, {
    method: "POST",
    headers: { ...headers, Cookie: auth },
    body: JSON.stringify(body),
  });
}
async function action(
  method: string,
  args: unknown[],
  requestId: string = crypto.randomUUID(),
  auth = cookie,
) {
  return post("/api/actions/" + method, { args, requestId }, auth);
}
async function login(username: string, password = "OwnerPass123!") {
  const res = await post(
    "/api/auth/login",
    { role: "admin", username, password },
    "",
  );
  expect(res.status).toBe(200);
  return res.headers.get("set-cookie")!.split(";")[0]!;
}
beforeEach(async () => {
  sql = openDatabase(":memory:");
  await createAccount(
    sql,
    { username: "owner", name: "店主", password: "OwnerPass123!" },
    "admin",
  );
  const app = await createApp(sql, { origins: ["http://localhost"] });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.on("listening", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  cookie = await login("owner");
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  sql.close();
});
describe("operating commands and scoped reads", () => {
  it("rejects missing command keys by default before any business side effect", async () => {
    const before = readDatabase(sql).revision;
    const response = await post("/api/actions/saveSupplier", {
      args: [{ name: "不可写入", contact: "", active: true, version: 0 }],
    });
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("REQUEST_ID_REQUIRED");
    expect(readDatabase(sql).revision).toBe(before);
    expect(readDatabase(sql).suppliers).toHaveLength(0);
  });
  it("receives purchasing partially, replays lost result once and rejects over-receipt atomically", async () => {
    const supplier = (
      await (
        await action("saveSupplier", [
          { name: "测试供货商", contact: "", active: true, version: 0 },
        ])
      ).json()
    ).result;
    const product = readDatabase(sql).products[0]!,
      sku = product.skus[0]!,
      stock = sku.stock;
    let po = (
      await (
        await action("createPurchaseOrder", [
          {
            supplierId: supplier.id,
            lines: [
              {
                productId: product.id,
                skuId: sku.id,
                quantity: 5,
                unitCost: 123,
              },
            ],
          },
        ])
      ).json()
    ).result;
    po = (await (await action("orderPurchase", [po.id, po.version])).json())
      .result;
    const args = [
        {
          id: po.id,
          version: po.version,
          lines: [{ skuId: sku.id, quantity: 2 }],
        },
      ],
      key = "receive-lost-response";
    const first = await action("receivePurchase", args, key);
    expect(first.status).toBe(200);
    const result = (await first.json()).result;
    const replay = await action("receivePurchase", args, key);
    expect((await replay.json()).result).toEqual(result);
    expect(readDatabase(sql).products[0]!.skus[0]!.stock).toBe(stock + 2);
    expect(
      readDatabase(sql).ledger.filter(
        (l) => l.reference === result.receipts[0].id,
      ),
    ).toHaveLength(1);
    const failed = await action("receivePurchase", [
      {
        id: po.id,
        version: result.version,
        lines: [{ skuId: sku.id, quantity: 4 }],
      },
    ]);
    expect(failed.status).toBe(400);
    expect(readDatabase(sql).products[0]!.skus[0]!.stock).toBe(stock + 2);
    const lookup = await fetch(
      base + "/api/requests/" + key + "?method=receivePurchase",
      { headers: { Cookie: cookie } },
    );
    expect((await lookup.json()).result).toEqual(result);
    expect(
      (
        await fetch(base + "/api/admin/reconciliation", {
          headers: { Cookie: cookie },
        })
      ).status,
    ).toBe(200);
  });
  it("enforces employee permissions, prevents last-owner removal and revokes changed staff sessions", async () => {
    const staff = (
      await (
        await action("saveStaff", [
          {
            username: "stockworker",
            name: "仓储",
            password: "WorkerPass123!",
            staffRole: "warehouse",
            active: true,
          },
        ])
      ).json()
    ).result;
    const worker = await login("stockworker", "WorkerPass123!");
    expect(
      (
        await action(
          "savePromotion",
          [
            {
              name: "非法活动",
              threshold: 1000,
              discount: 100,
              startsAt: "2026-01-01T00:00:00Z",
              endsAt: "2030-01-01T00:00:00Z",
              active: true,
              version: 0,
            },
          ],
          crypto.randomUUID(),
          worker,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(base + "/api/collections/ledger?role=admin", {
          headers: { Cookie: worker },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(base + "/api/state?role=admin", {
          headers: { Cookie: worker },
        })
      ).status,
    ).toBe(403);
    const dashboard = await (
      await fetch(base + "/api/admin/dashboard", {
        headers: { Cookie: worker },
      })
    ).json();
    expect(dashboard.income).toBeNull();
    expect(
      (await action("saveStaff", [{ ...staff, active: false }])).status,
    ).toBe(200);
    expect(
      (
        await fetch(base + "/api/collections/orders?role=admin", {
          headers: { Cookie: worker },
        })
      ).status,
    ).toBe(401);
    const owner = sql
      .prepare("SELECT id FROM accounts WHERE username='owner'")
      .get()!;
    expect(
      (
        await action("saveStaff", [
          {
            id: owner.id,
            username: "owner",
            name: "店主",
            staffRole: "finance",
            active: true,
          },
        ])
      ).status,
    ).toBe(400);
    const raw = sql
      .prepare(
        "SELECT fingerprint FROM command_results WHERE method='saveStaff'",
      )
      .all();
    expect(JSON.stringify(raw)).not.toContain("WorkerPass123");
  });
  it("scopes commands by owner and distinguishes stale versions and changed key payloads", async () => {
    const key = "same-shipping-key",
      args = [
        {
          name: "上海配送",
          province: "上海",
          enabled: true,
          fee: 500,
          freeAbove: 10000,
          version: 0,
        },
      ];
    const first = await action("saveShippingRule", args, key);
    expect(first.status).toBe(200);
    const rule = (await first.json()).result;
    expect(
      (await action("saveShippingRule", [{ ...rule, fee: 1000 }], key)).status,
    ).toBe(409);
    expect(
      (await action("saveShippingRule", [{ ...rule, fee: 1000, version: 0 }]))
        .status,
    ).toBe(409);
    const anonymous = await fetch(
      base + "/api/requests/" + key + "?method=saveShippingRule",
    );
    expect(anonymous.status).toBe(401);
    expect((await action("resetDemo", [])).status).toBe(403);
  });
  it("uses bounded collection reads, hides private records and exposes request identifiers", async () => {
    const db = readDatabase(sql);
    db.notifications = [
      {
        id: "private-note",
        userId: "other",
        text: "private",
        read: false,
        createdAt: new Date().toISOString(),
      },
    ];
    db.pointsEntries = [
      {
        id: "private-points",
        userId: "other",
        orderId: "historical",
        delta: 20,
        reason: "private",
        createdAt: new Date().toISOString(),
      },
    ];
    db.suppliers = [
      {
        id: "private-supplier",
        name: "供应商",
        contact: "private-contact",
        active: true,
        version: 1,
      },
    ];
    writeDatabase(sql, db);
    const legacy = await (await fetch(base + "/api/state")).json();
    expect(legacy.db.notifications).toEqual([]);
    expect(legacy.db.pointsEntries).toEqual([]);
    expect(legacy.db.suppliers).toEqual([]);
    const bootstrap = await fetch(base + "/api/bootstrap");
    expect(bootstrap.headers.get("X-Request-ID")).toBeTruthy();
    const state = await bootstrap.json();
    expect(state.db.orders).toEqual([]);
    expect(state.db.notifications).toEqual([]);
    const page = await (
      await fetch(base + "/api/collections/products?page=2&pageSize=3")
    ).json();
    expect(page.items).toHaveLength(3);
    expect(page.total).toBe(
      readDatabase(sql).products.filter((p) => p.active).length,
    );
    expect(
      (await fetch(base + "/api/collections/products?pageSize=100000")).status,
    ).toBe(400);
    expect((await fetch(base + "/api/collections/notifications")).status).toBe(
      401,
    );
    expect((await fetch(base + "/api/collections/ledger")).status).toBe(401);
  });
});
