import express, { type ErrorRequestHandler } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { Server } from "node:http";
import { mkdirSync, mkdtempSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createSeed } from "../../shared/domain/seed";
import type { Database } from "../../shared/domain/types";
import { hashPassword } from "../src/auth";
import { openDatabase, readDatabase } from "../src/database";
import { ensureRuntimeSchema } from "../src/runtime";
import {
  ensureAccountSchema,
  registerAccountRoutes,
} from "../src/production/accounts";
import {
  ensureExternalSchema,
  anonymizeExternalAccount,
  exportExternalAccountData,
} from "../src/production/external";
import {
  anonymizePaymentAccount,
  assertPaymentsClosable,
  ensurePaymentSchema,
} from "../src/production/payments";

const password = "LegacyPrivacy123!";
const pii = {
  name: "注销验收甲姓名",
  username: "legacy_privacy_a",
  phone: "13912345678",
  detail: "注销验收甲私人地址88号",
  province: "注销验收甲省份",
  freeText: "注销验收甲售后私密说明",
  ip: "198.51.100.74",
};
let sql: DatabaseSync, server: Server, base: string, oldBytes: string;
let failAfterAnonymize = false;
const headers = {
  "Content-Type": "application/json",
  "X-ShopMate-Request": "1",
};
const legacy = () =>
  JSON.parse(
    String(sql.prepare("SELECT data FROM state WHERE id=1").get()!.data),
  ) as Database;
const stateBytes = () =>
  String(sql.prepare("SELECT data FROM state WHERE id=1").get()!.data);
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function otherUserRecords(db: Database) {
  return {
    user: db.users.find((row) => row.id === "u2"),
    addresses: db.addresses.filter((row) => row.userId === "u2"),
    orders: db.orders.filter((row) => row.userId === "u2"),
    sales: db.afterSales.filter((row) => row.userId === "u2"),
    favorites: db.favorites.u2,
  };
}
function payments() {
  return sql.prepare("SELECT * FROM production_payments ORDER BY id").all();
}
function assertLegacyImmutable() {
  expect(() =>
    sql.prepare("UPDATE state SET data='{}' WHERE id=1").run(),
  ).toThrow("legacy state is read-only migration evidence");
  expect(() => sql.prepare("DELETE FROM state WHERE id=1").run()).toThrow(
    "legacy state is read-only migration evidence",
  );
}
async function post(path: string, body: unknown, cookie = "") {
  return fetch(base + path, {
    method: "POST",
    headers: { ...headers, Cookie: cookie },
    body: JSON.stringify(body),
  });
}
async function login() {
  const response = await post("/api/auth/login", {
    role: "user",
    username: pii.username,
    password,
  });
  expect(response.status).toBe(200);
  return response.headers
    .getSetCookie()
    .find((value) => value.startsWith("shopmate_user="))!
    .split(";")[0]!;
}
function close(cookie: string) {
  return post(
    "/api/auth/close",
    {
      password,
      confirmation: "注销账号",
      requestId: randomUUID(),
    },
    cookie,
  );
}

beforeEach(async () => {
  vi.stubEnv("SHOP_MODE", "production");
  failAfterAnonymize = false;
  const seed = createSeed();
  seed.users[0] = { id: "u1", username: pii.username, name: pii.name };
  const address = seed.addresses.find((row) => row.userId === "u1")!;
  Object.assign(address, {
    name: pii.name,
    phone: pii.phone,
    detail: pii.detail,
    province: pii.province,
  });
  for (const order of seed.orders) {
    order.status = "completed";
    if (order.userId === "u1") {
      order.address = { ...address };
      order.tracking = pii.freeText;
      order.events[0]!.note = pii.freeText;
    }
  }
  seed.afterSales = ["u1", "u2"].map((userId) => {
    const order = seed.orders.find((row) => row.userId === userId)!;
    const text = userId === "u1" ? pii.freeText : "乙用户售后原文完整保留";
    return {
      id: `legacy-sale-${userId}`,
      orderId: order.id,
      userId,
      reason: text,
      description: text,
      note: text,
      status: "rejected" as const,
      requiresReturn: false,
      lines: [{ orderItemId: order.items[0]!.id, quantity: 1, amount: 100 }],
      refundAmount: 100,
      events: [
        {
          at: order.createdAt,
          actor: "system",
          action: "rejected",
          note: text,
        },
      ],
      createdAt: order.createdAt,
    };
  });
  oldBytes = JSON.stringify(seed);
  const parent = resolve(".e2e");
  mkdirSync(parent, { recursive: true });
  const path = join(
    mkdtempSync(join(parent, "production-privacy-")),
    "legacy.sqlite",
  );
  // Keep the generated legacy fixture for inspecting the migration and redaction evidence.
  const original = new DatabaseSync(path);
  original.exec(`CREATE TABLE accounts(id TEXT PRIMARY KEY,username TEXT,name TEXT,role TEXT,password_hash TEXT,created_at INTEGER);
    CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,account_id TEXT,expires_at INTEGER);
    CREATE TABLE state(id INTEGER PRIMARY KEY,data TEXT);`);
  original.prepare("INSERT INTO state VALUES(1,?)").run(oldBytes);
  const hash = await hashPassword(password);
  for (const user of seed.users)
    original
      .prepare("INSERT INTO accounts VALUES(?,?,?,?,?,?)")
      .run(user.id, user.username, user.name, "user", hash, 1);
  original.close();
  sql = openDatabase(path);
  expect(stateBytes()).toBe(oldBytes);
  ensureRuntimeSchema(sql);
  ensureAccountSchema(sql);
  ensureExternalSchema(sql);
  ensurePaymentSchema(sql);
  for (const userId of ["u1", "u2"]) {
    const order = seed.orders.find((row) => row.userId === userId)!;
    sql
      .prepare(
        "INSERT INTO production_payments(id,order_id,user_id,provider,status,request_id,data,next_attempt_at,settle_date) VALUES(?,?,?,'wechatpay','succeeded',?,?,0,'2026-01-01')",
      )
      .run(
        `legacy-payment-${userId}`,
        order.id,
        userId,
        `legacy-request-${userId}`,
        JSON.stringify({
          id: `legacy-payment-${userId}`,
          orderId: order.id,
          userId,
          provider: "wechatpay",
          status: "succeeded",
          amount: order.total,
          ip: userId === "u1" ? pii.ip : "203.0.113.8",
          providerTransactionId: `provider-${userId}`,
        }),
      );
  }
  const app = express();
  app.use(express.json());
  registerAccountRoutes(app, sql, {
    production: true,
    encryptionKey: randomBytes(32),
    emailEnabled: true,
    smsEnabled: false,
    secureCookies: false,
    sendVerification: async () => {
      throw new Error("VERIFICATION_NOT_USED_IN_LEGACY_PRIVACY_TEST");
    },
    assertClosable: (id) => assertPaymentsClosable(sql, id),
    exportAccountData: (id) => exportExternalAccountData(sql, id),
    anonymizeAccount: (id) => {
      anonymizeExternalAccount(sql, id);
      anonymizePaymentAccount(sql, id);
      if (failAfterAnonymize) throw new Error("INJECTED_CLOSURE_FAILURE");
    },
  });
  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) =>
    res
      .status(error.status ?? 500)
      .json({ message: error.message, code: error.code });
  app.use(errorHandler);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((done) => server.once("listening", done));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  sql.close();
  vi.unstubAllEnvs();
});

describe("legacy production account privacy through HTTP", () => {
  it("redacts the upgraded legacy source and payment IP while retaining other users and financial facts", async () => {
    const cookie = await login();
    const before = structuredClone(readDatabase(sql));
    const rawBefore = legacy();
    const otherPayment = payments().find((row) => row.user_id === "u2");
    assertLegacyImmutable();
    const exported = await post("/api/auth/export", { password }, cookie);
    expect(exported.status).toBe(200);
    const personal = await exported.json();
    expect(personal.profile.name).toBe(pii.name);
    expect(
      personal.orders.every((row: { userId: string }) => row.userId === "u1"),
    ).toBe(true);
    expect(JSON.stringify(personal)).not.toContain("乙用户售后原文完整保留");
    expect((await close(cookie)).status).toBe(200);
    const after = readDatabase(sql),
      rawAfter = legacy();
    for (const secret of Object.values(pii)) {
      expect(JSON.stringify(after)).not.toContain(secret);
      expect(stateBytes()).not.toContain(secret);
      expect(
        JSON.stringify(payments().filter((row) => row.user_id === "u1")),
      ).not.toContain(secret);
    }
    expect(otherUserRecords(after)).toEqual(otherUserRecords(before));
    expect(otherUserRecords(rawAfter)).toEqual(otherUserRecords(rawBefore));
    expect(after.ledger).toEqual(before.ledger);
    expect(rawAfter.ledger).toEqual(rawBefore.ledger);
    expect(payments().find((row) => row.user_id === "u2")).toEqual(
      otherPayment,
    );
    const payment = JSON.parse(
      String(payments().find((row) => row.user_id === "u1")!.data),
    );
    expect(payment).not.toHaveProperty("ip");
    expect(payment).toMatchObject({
      status: "succeeded",
      amount: before.orders[0]!.total,
      providerTransactionId: "provider-u1",
    });
    expect(
      sql.prepare("SELECT active FROM accounts WHERE id='u1'").get()?.active,
    ).toBe(0);
    expect(
      sql.prepare("SELECT count(*) n FROM sessions WHERE account_id='u1'").get()
        ?.n,
    ).toBe(0);
    assertLegacyImmutable();
    const audit = sql
      .prepare(
        "SELECT result,object_id FROM operation_audit WHERE action='account.legacy-redact' AND actor_id='u1'",
      )
      .get();
    expect(audit).toBeDefined();
    expect(audit!.result).toBe("ok");
    expect(String(audit!.object_id)).toBe(
      `${digest(oldBytes)}:${digest(stateBytes())}`,
    );
    expect(JSON.stringify(audit)).not.toContain(pii.name);
  });
  it("rolls legacy redaction, payment IP, account and sessions back if a later closure step fails", async () => {
    const cookie = await login();
    const before = structuredClone(readDatabase(sql));
    const beforePayments = payments();
    const beforeAccount = sql
      .prepare("SELECT * FROM accounts WHERE id='u1'")
      .get();
    const beforeSessions = sql
      .prepare("SELECT * FROM sessions ORDER BY token_hash")
      .all();
    const triggers = sql
      .prepare(
        "SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='state' ORDER BY name",
      )
      .all();
    failAfterAnonymize = true;
    const response = await close(cookie);
    expect(response.status).toBe(500);
    expect((await response.json()).message).toBe("INJECTED_CLOSURE_FAILURE");
    expect(stateBytes()).toBe(oldBytes);
    expect(readDatabase(sql)).toEqual(before);
    expect(payments()).toEqual(beforePayments);
    expect(sql.prepare("SELECT * FROM accounts WHERE id='u1'").get()).toEqual(
      beforeAccount,
    );
    expect(
      sql.prepare("SELECT * FROM sessions ORDER BY token_hash").all(),
    ).toEqual(beforeSessions);
    expect(
      sql
        .prepare(
          "SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='state' ORDER BY name",
        )
        .all(),
    ).toEqual(triggers);
    expect(
      sql
        .prepare(
          "SELECT count(*) n FROM operation_audit WHERE action IN ('account.close','account.legacy-redact')",
        )
        .get()?.n,
    ).toBe(0);
    assertLegacyImmutable();
    failAfterAnonymize = false;
    expect((await close(cookie)).status).toBe(200);
  });
});
