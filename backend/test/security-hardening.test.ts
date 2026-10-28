import { afterEach, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import type { Server } from "node:http";
import { openDatabase } from "../src/database";
import {
  createAccount,
  findSession,
  migrateLegacyAdminAccess,
  tokenHash,
} from "../src/auth";
import { ensureRuntimeSchema } from "../src/runtime";
import { createApp } from "../src/app";
import { grants, methodPermission, permits } from "../src/permissions";
import { methods } from "../src/validation";

let server: Server | undefined;
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

it("rejects compressed JSON before decompression and remains available for ordinary requests", async () => {
  const sql = openDatabase(":memory:");
  try {
    const app = await createApp(sql, { origins: ["http://localhost"] });
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const headers = {
      "Content-Type": "application/json",
      "X-ShopMate-Request": "1",
    };
    const encoded = Buffer.concat([
      gzipSync('{"role":"user"}'),
      Buffer.from("trailing"),
    ]);
    const rejected = await fetch(base + "/api/auth/logout", {
      method: "POST",
      headers: { ...headers, "Content-Encoding": "gzip" },
      body: encoded,
    });
    expect(rejected.status).toBe(415);
    expect(await rejected.json()).toMatchObject({
      code: "UNSUPPORTED_CONTENT_ENCODING",
    });
    expect((await fetch(base + "/api/health")).status).toBe(200);
    const plain = await fetch(base + "/api/auth/logout", {
      method: "POST",
      headers,
      body: '{"role":"user"}',
    });
    expect(plain.status).toBe(200);
    expect(await plain.json()).toEqual({ ok: true });
  } finally {
    sql.close();
  }
});

it("creates explicit owner access atomically and fails closed after authorization data is lost", async () => {
  const sql = openDatabase(":memory:");
  try {
    const owner = await createAccount(
      sql,
      {
        username: "explicitowner",
        name: "店主",
        password: "OwnerPassword123!",
      },
      "admin",
    );
    expect(
      sql
        .prepare(
          "SELECT staff_role,active FROM staff_access WHERE account_id=?",
        )
        .get(owner.id),
    ).toEqual({ staff_role: "owner", active: 1 });
    sql
      .prepare("INSERT INTO sessions VALUES(?,?,?)")
      .run(tokenHash("test-session"), owner.id, Date.now() + 60000);
    const req = {
      headers: { cookie: "shopmate_admin=test-session" },
    } as Parameters<typeof findSession>[1];
    migrateLegacyAdminAccess(sql);
    expect(findSession(sql, req, "admin")?.staffRole).toBe("owner");
    sql.prepare("DELETE FROM staff_access WHERE account_id=?").run(owner.id);
    ensureRuntimeSchema(sql);
    migrateLegacyAdminAccess(sql);
    expect(findSession(sql, req, "admin")).toBeNull();
    expect(
      sql
        .prepare("SELECT * FROM staff_access WHERE account_id=?")
        .get(owner.id),
    ).toBeUndefined();
    const app = await createApp(sql, { origins: ["http://localhost"] });
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const login = await fetch(base + "/api/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-ShopMate-Request": "1",
      },
      body: JSON.stringify({
        username: "explicitowner",
        password: "OwnerPassword123!",
        role: "admin",
      }),
    });
    expect(login.status).toBe(403);
    expect(login.headers.get("set-cookie")).toBeNull();
    expect(
      (
        await fetch(base + "/api/admin/diagnostics", {
          headers: { Cookie: "shopmate_admin=test-session" },
        })
      ).status,
    ).toBe(401);
  } finally {
    sql.close();
  }
});

it("migrates identifiable historical owners once without promoting missing employees", () => {
  const sql = openDatabase(":memory:");
  try {
    ensureRuntimeSchema(sql);
    const legacyId = crypto.randomUUID(),
      insert = sql.prepare("INSERT INTO accounts VALUES(?,?,?,?,?,?)");
    insert.run(legacyId, "legacyowner", "历史店主", "admin", "unused", 1);
    insert.run("staff-lost", "loststaff", "权限损坏员工", "admin", "unused", 2);
    migrateLegacyAdminAccess(sql);
    expect(
      sql
        .prepare("SELECT account_id,staff_role,active FROM staff_access")
        .all(),
    ).toEqual([{ account_id: legacyId, staff_role: "owner", active: 1 }]);
    sql.prepare("DELETE FROM staff_access WHERE account_id=?").run(legacyId);
    migrateLegacyAdminAccess(sql);
    expect(sql.prepare("SELECT * FROM staff_access").all()).toHaveLength(0);
  } finally {
    sql.close();
  }
});

it("maps every registered admin command explicitly and denies missing or unknown authorization", () => {
  for (const [method, definition] of Object.entries(methods))
    if (definition.role === "admin")
      expect(grants.owner).toContain(
        methodPermission(
          method,
          method === "processAfterSale" ? ["sale", "approve"] : [],
        ),
      );
  expect(methodPermission("newUnmappedOperation", [])).toBe("unmapped");
  expect(methodPermission("processAfterSale", ["sale", "unknown"])).toBe(
    "unmapped",
  );
  expect(
    permits({ id: "broken", name: "broken", role: "admin" }, "staff"),
  ).toBe(false);
  expect(
    permits(
      { id: "user", name: "user", role: "user", staffRole: "owner" },
      "staff",
    ),
  ).toBe(false);
});
