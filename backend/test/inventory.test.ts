import { beforeEach, expect, it, vi } from "vitest";
import { catalogApi } from "../src/catalog";
import { commerceApi } from "../src/commerce";
import { context } from "../src/repository";
import { openDatabase, readDatabase, writeDatabase } from "../src/database";
import { createSeed } from "../../shared/domain/seed";
import { expireOrders } from "../src/commerce-rules";
import { createApp } from "../src/app";
import { createAccount } from "../src/auth";
const sql = openDatabase(":memory:");
const sessions = {
  user: { id: "u1", name: "用户", role: "user" as const },
  admin: { id: "admin", name: "管理员", role: "admin" as const },
};
function adjust(...args: unknown[]) {
  return context.run({ sql, ...sessions }, () =>
    (catalogApi.adjustStock as (...args: unknown[]) => Promise<unknown>)(
      ...args,
    ),
  );
}
const db = () => readDatabase(sql);
const quantity = () => db().products[0]!.skus[0]!.stock;
beforeEach(() => {
  vi.useRealTimers();
  writeDatabase(sql, createSeed());
});
it("重试同一补货请求只增加一次库存和采购支出，结果关联精确变动", async () => {
  const before = db(),
    stock = quantity();
  const input = [
    "p01",
    "p01-s1",
    3,
    12345,
    "补货幂等",
    { requestId: "restock-one" },
  ];
  const results = await Promise.all([adjust(...input), adjust(...input)]);
  expect(results[0]).toEqual(results[1]);
  expect(results[0]).toMatchObject({
    beforeStock: stock,
    afterStock: stock + 3,
    delta: 3,
  });
  const after = db();
  expect(quantity()).toBe(stock + 3);
  expect(after.inventory).toHaveLength(before.inventory.length + 1);
  expect(after.ledger).toHaveLength(before.ledger.length + 1);
  expect(after.ledger[0]).toMatchObject({
    amount: 12345,
    inventoryMovementId: after.inventory[0]!.id,
  });
  expect(after.inventory[0]).toMatchObject({
    beforeStock: stock,
    afterStock: stock + 3,
    mode: "delta",
  });
  for (const change of [
    ["p01", "p01-s1", 4, 12345, "补货幂等"],
    ["p01", "p01-s1", 3, 12346, "补货幂等"],
    ["p01", "p01-s1", 3, 12345, "不同说明"],
    ["p02", "p02-s1", 3, 12345, "补货幂等"],
  ])
    await expect(
      adjust(...change, { requestId: "restock-one" }),
    ).rejects.toMatchObject({ status: 409 });
  expect(db().inventory).toEqual(after.inventory);
  expect(db().ledger).toEqual(after.ledger);
});
it("盘点校验冻结基线，重试已完成盘点优先返回原结果且不计采购", async () => {
  const before = db(),
    stock = quantity();
  const options = {
    requestId: "count-one",
    mode: "count",
    expectedStock: stock,
  };
  const result = await adjust("p01", "p01-s1", 0, 0, "实盘为零", options);
  expect(result).toMatchObject({
    beforeStock: stock,
    afterStock: 0,
    delta: -stock,
  });
  await adjust("p01", "p01-s1", 2, 0, "后续补货");
  expect(await adjust("p01", "p01-s1", 0, 0, "实盘为零", options)).toEqual(
    result,
  );
  expect(quantity()).toBe(2);
  expect(db().ledger).toEqual(before.ledger);
  const after = db();
  await expect(
    adjust("p01", "p01-s1", 1, 0, "过期盘点", {
      requestId: "stale-count",
      mode: "count",
      expectedStock: stock,
    }),
  ).rejects.toMatchObject({ status: 409 });
  expect(db()).toEqual(after);
  await adjust("p01", "p01-s1", 2, 0, "实盘无差异", {
    requestId: "count-no-change",
    mode: "count",
    expectedStock: 2,
  });
  expect(db().inventory[0]).toMatchObject({
    delta: 0,
    beforeStock: 2,
    afterStock: 2,
    mode: "count",
  });
  expect(db().ledger).toEqual(before.ledger);
});
it("销售后陈旧盘点被拒绝，已预占订单不能被盘点归零破坏", async () => {
  async function order() {
    return context.run({ sql, ...sessions }, async () => {
      const quote = await commerceApi.quoteCheckout({
        source: {
          type: "buyNow",
          productId: "p01",
          skuId: "p01-s1",
          quantity: 1,
        },
        addressId: "a1",
      });
      return commerceApi.createOrder({
        quoteId: quote.id,
        requestId: crypto.randomUUID(),
      });
    });
  }
  const id = await order(),
    stock = quantity();
  const pay = () =>
    context.run({ sql, ...sessions }, () => commerceApi.payOrder(id));
  const settled = await Promise.allSettled([
    pay(),
    adjust("p01", "p01-s1", 0, 0, "销售竞争盘点", {
      requestId: "race-one",
      mode: "count",
      expectedStock: stock,
    }),
  ]);
  expect(settled.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
  expect(quantity()).toBe(stock - 1);
  const second = await order();
  const next = await Promise.allSettled([
    adjust("p01", "p01-s1", 0, 0, "盘点先归零", {
      requestId: "race-two",
      mode: "count",
      expectedStock: quantity(),
    }),
    context.run({ sql, ...sessions }, () => commerceApi.payOrder(second)),
  ]);
  expect(next.map((r) => r.status)).toEqual(["rejected", "fulfilled"]);
  expect(quantity()).toBe(stock - 2);
  expect(db().orders.find((o) => o.id === second)!.status).toBe("paid");
  expect(db().ledger.filter((l) => l.reference === second)).toHaveLength(1);
});
it("盘点/增量的非法数量金额和基线失败时不留下请求或流水", async () => {
  const before = db();
  for (const [value, cost, options] of [
    [-1, 0, { requestId: "bad", mode: "count", expectedStock: quantity() }],
    [1.5, 0, { requestId: "bad", mode: "count", expectedStock: quantity() }],
    [1, 1, { requestId: "bad", mode: "count", expectedStock: quantity() }],
    [1, 0, { requestId: "bad", mode: "count" }],
    [Number.MAX_SAFE_INTEGER, 0, { requestId: "bad" }],
    [-1, 1, { requestId: "bad" }],
    [0, 0, { requestId: "bad" }],
  ] as const)
    await expect(
      adjust("p01", "p01-s1", value, cost, "非法盘点", options),
    ).rejects.toThrow();
  expect(db()).toEqual(before);
});
it("幂等记录 24 小时清理，历史变动和采购流水保留；管理员请求隔离", async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date("2026-10-17T10:00:00Z"));
    await adjust("p01", "p01-s1", 1, 100, "按管理员隔离", {
      requestId: "same-key",
    });
    await context.run(
      { sql, ...sessions, admin: { ...sessions.admin, id: "admin-two" } },
      () =>
        (catalogApi.adjustStock as (...args: unknown[]) => Promise<unknown>)(
          "p01",
          "p01-s1",
          1,
          100,
          "按管理员隔离",
          { requestId: "same-key" },
        ),
    );
    const before = db();
    expect(Reflect.get(before, "inventoryRequests")).toHaveLength(2);
    expect(expireOrders(before, "2026-10-18T09:59:59Z")).toBe(true); // seed pending orders also expire
    expect(Reflect.get(before, "inventoryRequests")).toHaveLength(2);
    expireOrders(before, "2026-10-18T10:00:00Z");
    expect(Reflect.get(before, "inventoryRequests")).toEqual([]);
    expect(before.inventory).toEqual(db().inventory);
    expect(before.ledger).toEqual(db().ledger);
  } finally {
    vi.useRealTimers();
  }
});
it("库存 HTTP 兼容五参数、校验扩展参数并隔离管理员请求记录", async () => {
  const app = await createApp(sql, { origins: ["http://localhost"], allowLegacyCommands: true });
  await createAccount(
    sql,
    {
      username: "stockadmin",
      name: "库存管理",
      password: "InventoryAdmin123!",
    },
    "admin",
  );
  await createAccount(
    sql,
    { username: "stockuser", name: "库存用户", password: "InventoryUser123!" },
    "user",
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.on("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (path: string, body: unknown, cookie = "") =>
    fetch(base + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-ShopMate-Request": "1",
        Cookie: cookie,
      },
      body: JSON.stringify(body),
    });
  try {
    const adminLogin = await post("/api/auth/login", {
      username: "stockadmin",
      password: "InventoryAdmin123!",
      role: "admin",
    });
    const userLogin = await post("/api/auth/login", {
      username: "stockuser",
      password: "InventoryUser123!",
      role: "user",
    });
    const adminCookie = adminLogin.headers.get("set-cookie")!.split(";")[0]!,
      userCookie = userLogin.headers.get("set-cookie")!.split(";")[0]!;
    const args = [
      "p01",
      "p01-s1",
      1,
      100,
      "HTTP补货",
      { requestId: "http-one" },
    ];
    expect((await post("/api/actions/adjustStock", { args })).status).toBe(401);
    expect(
      (await post("/api/actions/adjustStock", { args }, userCookie)).status,
    ).toBe(401);
    const response = await post(
      "/api/actions/adjustStock",
      { args },
      adminCookie,
    );
    expect(response.status).toBe(200);
    expect((await response.json()).result).toMatchObject({ delta: 1 });
    expect(
      (
        await post(
          "/api/actions/adjustStock",
          { args: ["p01", "p01-s1", 1, 0, "旧参数"] },
          adminCookie,
        )
      ).status,
    ).toBe(200);
    for (const options of [
      {},
      { requestId: "bad", expectedStock: -1 },
      { requestId: "bad", mode: "other" },
      { requestId: "bad", unexpected: true },
    ])
      expect(
        (
          await post(
            "/api/actions/adjustStock",
            { args: [...args.slice(0, 5), options] },
            adminCookie,
          )
        ).status,
      ).toBe(400);
    for (const cookie of ["", userCookie, `${adminCookie}; ${userCookie}`]) {
      const visible = await (
        await fetch(base + "/api/state?role=user", {
          headers: { Cookie: cookie },
        })
      ).json();
      expect(visible.db.inventoryRequests).toEqual([]);
    }
    expect(db().inventoryRequests).toHaveLength(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
