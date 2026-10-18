import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { openDatabase, readDatabase, writeDatabase } from "../src/database";
import { createAccount, tokenHash } from "../src/auth";

let sql: DatabaseSync, server: Server, base: string;
const input = { username: "alice", name: "小艾", password: "AlicePass123!" };
const headers = {
  "Content-Type": "application/json",
  "X-ShopMate-Request": "1",
};
async function post(path: string, body: unknown, cookie = "", extra = {}) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { ...headers, Cookie: cookie, ...extra },
    body: JSON.stringify(body),
  });
}
const cookieOf = (response: Response) =>
  response.headers.get("set-cookie")!.split(";")[0]!;
async function state(cookie = "", role = "user") {
  return (
    await fetch(`${base}/api/state?role=${role}`, {
      headers: { Cookie: cookie },
    })
  ).json();
}
beforeEach(async () => {
  sql = openDatabase(":memory:");
  const app = await createApp(sql, {
    origins: ["http://localhost"],
    sessionTtl: 60_000,
    allowDemoReset: true,
    allowLegacyCommands: true,
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.on("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  sql.close();
});

describe("real authentication over HTTP", () => {
  it("finds only the user's own checkout request without changing business state", async () => {
    const cookie = cookieOf(await post("/api/auth/register", input));
    const action = async (method: string, args: unknown[]) => {
      const response = await post(`/api/actions/${method}`, { args }, cookie);
      expect(response.status).toBe(200);
      return (await response.json()).result;
    };
    await action("saveAddress", [
      {
        name: "收货人",
        phone: "13800000000",
        region: "上海",
        detail: "测试地址",
        isDefault: true,
      },
    ]);
    const address = (await state(cookie)).db.addresses[0];
    const quote = await action("quoteCheckout", [
      {
        source: {
          type: "buyNow",
          productId: "p01",
          skuId: "p01-s1",
          quantity: 1,
        },
        addressId: address.id,
      },
    ]);
    const requestId = crypto.randomUUID();
    const orderId = await action("createOrder", [
      { quoteId: quote.id, requestId },
    ]);
    const lookup = (token = cookie, quoteId = quote.id) =>
      fetch(`${base}/api/order-requests/${requestId}?quoteId=${quoteId}`, {
        headers: { Cookie: token },
      });
    const before = readDatabase(sql);
    expect((await lookup("")).status).toBe(401);
    expect(await (await lookup()).json()).toEqual({ orderId });
    expect(await (await lookup(cookie, "different-quote")).json()).toEqual({
      orderId: null,
    });
    const other = cookieOf(
      await post("/api/auth/register", { ...input, username: "bob" }),
    );
    expect(await (await lookup(other)).json()).toEqual({ orderId: null });
    // Registration is the only mutation above; lookup itself must preserve all business data.
    const afterRegistration = readDatabase(sql);
    await lookup();
    await lookup(other);
    expect(readDatabase(sql)).toEqual(afterRegistration);
    const compacted = readDatabase(sql);
    compacted.orderRequests = [];
    writeDatabase(sql, compacted);
    expect(await (await lookup()).json()).toEqual({ orderId });
    expect(readDatabase(sql)).toEqual(compacted);
    expect(readDatabase(sql).orders).toEqual(before.orders);
  });
  it("registers once, hashes credentials, issues a private cookie and validates passwords", async () => {
    const response = await post("/api/auth/register", input);
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toMatchObject({ name: "小艾", role: "user" });
    expect(body).not.toHaveProperty("password_hash");
    const cookie = cookieOf(response);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("SameSite=Strict");
    const account = sql.prepare("SELECT * FROM accounts").get()!;
    expect(account.password_hash).toMatch(/^scrypt\$/);
    expect(account.password_hash).not.toContain(input.password);
    expect((await state(cookie)).sessions.user.id).toBe(body.id);
    expect((await state(cookie)).db.addresses).toEqual([]);
    expect(
      (await post("/api/auth/register", { ...input, username: "ALICE" }))
        .status,
    ).toBe(409);
    expect(
      (
        await post("/api/auth/login", {
          ...input,
          name: undefined,
          role: "user",
          password: "wrong",
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await post("/api/auth/login", {
          role: "user",
          username: "ALICE",
          password: input.password,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post("/api/auth/login", {
          role: "admin",
          username: "alice",
          password: input.password,
        })
      ).status,
    ).toBe(401);
  });
  it("rejects invalid registrations and public role escalation", async () => {
    for (const body of [
      { ...input, password: "short" },
      { ...input, username: "1bad" },
      { ...input, name: " " },
      { ...input, role: "admin" },
    ]) {
      expect((await post("/api/auth/register", body)).status).toBe(400);
    }
    expect(sql.prepare("SELECT count(*) AS n FROM accounts").get()!.n).toBe(0);
  });
  it("enforces authentication, server ownership and response isolation", async () => {
    const a = await post("/api/auth/register", input),
      aCookie = cookieOf(a);
    const b = await post("/api/auth/register", { ...input, username: "bob" }),
      bCookie = cookieOf(b);
    const action = (method: string, args: unknown[], cookie = "") =>
      post(`/api/actions/${method}`, { args }, cookie);
    expect((await action("addCart", ["p01", "p01-s1", 1])).status).toBe(401);
    expect((await action("toggleProduct", ["p01"], aCookie)).status).toBe(401);
    expect(
      (
        await action(
          "saveAddress",
          [
            {
              name: "收货人",
              phone: "13800000000",
              region: "上海",
              detail: "测试路",
              isDefault: true,
            },
          ],
          aCookie,
        )
      ).status,
    ).toBe(200);
    const address = (await state(aCookie)).db.addresses[0];
    await action("addCart", ["p01", "p01-s1", 1], aCookie);
    const ownCart = (await state(aCookie)).db.carts;
    const quote = await (
      await action(
        "quoteCheckout",
        [
          {
            addressId: address.id,
            source: {
              type: "cart",
              cartIds: ownCart.map((c: { id: string }) => c.id),
            },
          },
        ],
        aCookie,
      )
    ).json();
    expect(quote.result.total).toBe(39900);
    const order = await (
      await action(
        "createOrder",
        [{ quoteId: quote.result.id, requestId: "auth-order" }],
        aCookie,
      )
    ).json();
    expect(typeof order.result).toBe("string");
    expect((await action("payOrder", [order.result], bCookie)).status).toBe(
      400,
    );
    expect(
      (
        await action(
          "saveAddress",
          [{ ...address, userId: undefined }],
          bCookie,
        )
      ).status,
    ).toBe(400);
    const bState = await state(bCookie);
    expect(bState.db.addresses).toEqual([]);
    expect(bState.db.orders).toEqual([]);
    expect(bState.db.users).toHaveLength(1);
    expect((await state()).db.users).toEqual([]);
    expect((await state(aCookie, "admin")).db.ledger).toEqual([]);
    expect(
      (await action("createConversation", [{ userId: "forged" }], aCookie))
        .status,
    ).toBe(400);
    const before = readDatabase(sql);
    expect(
      (await action("updateCart", ["bad", { selected: "yes" }], aCookie))
        .status,
    ).toBe(400);
    expect(readDatabase(sql)).toEqual(before);
  });
  it("revokes logout and expired sessions and ignores forged browser identities", async () => {
    const response = await post("/api/auth/register", input),
      cookie = cookieOf(response);
    const token = cookie.split("=")[1]!;
    expect(
      sql.prepare("SELECT token_hash FROM sessions").get()!.token_hash,
    ).toBe(tokenHash(token));
    await post("/api/auth/logout", { role: "user" }, cookie);
    expect((await state(cookie)).sessions.user).toBeNull();
    expect(
      (await post("/api/actions/favorite", { args: ["p01"] }, cookie)).status,
    ).toBe(401);
    const next = await post("/api/auth/login", {
      role: "user",
      username: input.username,
      password: input.password,
    });
    sql.prepare("UPDATE sessions SET expires_at=0").run();
    expect((await state(cookieOf(next))).sessions.user).toBeNull();
    expect(
      (await state('shopmate_user={"id":"admin","role":"admin"}', "admin")).db
        .users,
    ).toEqual([]);
  });
  it("rotates login tokens and preserves the other role when logging out", async () => {
    await createAccount(
      sql,
      { username: "admin", name: "管理员", password: "AdminPass123!" },
      "admin",
    );
    const user = cookieOf(await post("/api/auth/register", input));
    const admin = cookieOf(
      await post("/api/auth/login", {
        role: "admin",
        username: "admin",
        password: "AdminPass123!",
      }),
    );
    const both = `${user}; ${admin}`;
    expect((await state(both, "admin")).sessions.admin.role).toBe("admin");
    expect(
      (await post("/api/actions/resetDemo", { args: [] }, both)).status,
    ).toBe(200);
    expect((await state(user)).sessions.user).not.toBeNull();
    expect((await state(user)).db.users).toHaveLength(1);
    const again = await post(
      "/api/auth/login",
      { role: "user", username: "alice", password: input.password },
      both,
    );
    expect(cookieOf(again)).not.toBe(user);
    expect((await state(user)).sessions.user).toBeNull();
    const rotated = `${cookieOf(again)}; ${admin}`;
    await post("/api/auth/logout", { role: "admin" }, rotated);
    const snapshot = await state(rotated);
    expect(snapshot.sessions.user).not.toBeNull();
    expect(snapshot.sessions.admin).toBeNull();
  });
  it("blocks CSRF, unexpected actions, malformed input and excessive login attempts", async () => {
    expect(
      (
        await post("/api/auth/register", input, "", {
          Origin: "https://evil.example",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await post("/api/auth/register", input, "", {
          "X-ShopMate-Request": "",
        })
      ).status,
    ).toBe(403);
    expect((await post("/api/actions/__proto__", { args: [] })).status).toBe(
      404,
    );
    expect(
      (
        await fetch(`${base}/api/auth/login`, {
          method: "POST",
          headers,
          body: "{",
        })
      ).status,
    ).toBe(400);
    for (let i = 0; i < 10; i++)
      expect(
        (
          await post("/api/auth/login", {
            role: "user",
            username: "unknown",
            password: "wrong",
          })
        ).status,
      ).toBe(401);
    expect(
      (
        await post("/api/auth/login", {
          role: "user",
          username: "unknown",
          password: "wrong",
        })
      ).status,
    ).toBe(429);
  });
  it("persists accounts and sessions across a database reopen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shopmate-auth-"));
    try {
      let disk = openDatabase(join(dir, "test.sqlite"));
      const account = await createAccount(disk, input);
      disk
        .prepare("INSERT INTO sessions VALUES (?, ?, ?)")
        .run(tokenHash("persisted"), account.id, Date.now() + 60000);
      disk.close();
      disk = openDatabase(join(dir, "test.sqlite"));
      expect(readDatabase(disk).users[0]?.id).toBe(account.id);
      expect(
        disk
          .prepare("SELECT account_id FROM sessions WHERE token_hash=?")
          .get(tokenHash("persisted"))!.account_id,
      ).toBe(account.id);
      disk.close();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
