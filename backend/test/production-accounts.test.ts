import express, { type ErrorRequestHandler } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { generate } from "otplib";
import { randomBytes } from "node:crypto";
import { openDatabase, readDatabase, writeDatabase } from "../src/database";
import { createAccount, findSession, tokenHash } from "../src/auth";
import { ensureRuntimeSchema } from "../src/runtime";
import { createSeed } from "../../shared/domain/seed";
import {
  cleanupAccountChallenges,
  ensureAccountSchema,
  readMerchant,
  registerAccountRoutes,
  requireVerifiedContact,
  resetMfa,
  type AccountOptions,
} from "../src/production/accounts";

let sql: DatabaseSync, server: Server, base: string;
const sent: {
  channel: "email" | "phone";
  target: string;
  code: string;
  challengeId: string;
}[] = [];
let deliveryFails = false;
const input = { username: "alice", name: "小艾", password: "AlicePass123!" };
const headers = {
  "Content-Type": "application/json",
  "X-ShopMate-Request": "1",
};
const merchant = {
  legalName: "测试商家",
  serviceEmail: "support@example.test",
  servicePhone: "",
  returnAddress: "测试退货地址",
  privacy: {
    version: "p1",
    title: "隐私政策",
    text: "测试资料仅用于完成交易。",
  },
  terms: { version: "t1", title: "服务协议", text: "测试商品交易规则。" },
};
const cookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0]!)
    .filter((value) => !value.endsWith("="));
function cookieOf(response: Response, name = "shopmate_user") {
  return cookies(response).find((value) => value.startsWith(`${name}=`)) ?? "";
}
function post(path: string, body: unknown, cookie = "") {
  return fetch(base + path, {
    method: "POST",
    headers: { ...headers, Cookie: cookie },
    body: JSON.stringify(body),
  });
}
async function proof(
  purpose: "register" | "bind" | "recover",
  target: string,
  cookie = "",
  username?: string,
) {
  const send = await post(
    "/api/auth/verification/send",
    { channel: "email", target, purpose, ...(username ? { username } : {}) },
    cookie,
  );
  expect(send.status).toBe(202);
  const { challengeId } = await send.json();
  const delivery = sent.find((item) => item.challengeId === challengeId)!;
  const result = await post(
    "/api/auth/verification/verify",
    { challengeId, code: delivery.code },
    cookie,
  );
  expect(result.status).toBe(200);
  return (await result.json()).verificationToken as string;
}
async function register(target = "alice@example.test", username = "alice") {
  const verificationToken = await proof("register", target);
  const response = await post("/api/auth/register", {
    ...input,
    username,
    verificationToken,
    privacyVersion: "p1",
    termsVersion: "t1",
  });
  expect(response.status).toBe(201);
  return {
    cookie: cookieOf(response),
    account: await response.json(),
    verificationToken,
  };
}
beforeEach(async () => {
  vi.stubEnv("SHOP_MODE", "production");
  sql = openDatabase(":memory:");
  ensureRuntimeSchema(sql);
  ensureAccountSchema(sql);
  sql
    .prepare("UPDATE merchant_profile SET data=? WHERE id=1")
    .run(JSON.stringify({ ...readMerchant(sql), ...merchant }));
  sent.length = 0;
  deliveryFails = false;
  const options: AccountOptions = {
    production: true,
    encryptionKey: randomBytes(32),
    emailEnabled: true,
    smsEnabled: true,
    secureCookies: false,
    sendVerification: async (message) => {
      if (deliveryFails) throw new Error("SEND_FAILED");
      sent.push(message);
    },
    assertClosable: (id) => {
      if (id === "blocked-payment") throw new Error("UNRESOLVED");
    },
  };
  const app = express();
  app.use(express.json());
  registerAccountRoutes(app, sql, options);
  app.get("/test/session/:role", (req, res) => {
    const account = findSession(
      sql,
      req,
      req.params.role === "admin" ? "admin" : "user",
    );
    res.status(account ? 200 : 401).json(account);
  });
  const onError: ErrorRequestHandler = (error, _req, res, _next) =>
    res
      .status(error.status ?? (error.name === "ZodError" ? 400 : 500))
      .json({ message: error.message, code: error.code });
  app.use(onError);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  sql.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("production account lifecycle through HTTP", () => {
  it("normalizes verified phone ownership and restricts versioned merchant edits to settings staff", async () => {
    const send = await post("/api/auth/verification/send", {
      channel: "phone",
      target: "+8613800000003",
      purpose: "register",
    });
    expect(send.status).toBe(202);
    expect(sent[0]!.target).toBe("13800000003");
    const challengeId = (await send.json()).challengeId;
    const checked = await post("/api/auth/verification/verify", {
      challengeId,
      code: sent[0]!.code,
    });
    const verificationToken = (await checked.json()).verificationToken;
    const registered = await post("/api/auth/register", {
      ...input,
      verificationToken,
      privacyVersion: "p1",
      termsVersion: "t1",
    });
    expect(registered.status).toBe(201);
    const userCookie = cookieOf(registered);
    const body = {
      merchant: { ...readMerchant(sql), legalName: "新商家名称" },
      requestId: crypto.randomUUID(),
    };
    expect((await post("/api/admin/merchant", body, userCookie)).status).toBe(
      401,
    );
    const owner = await createAccount(
      sql,
      { ...input, username: "owner" },
      "admin",
    );
    const token = randomBytes(32).toString("hex");
    sql
      .prepare(
        "INSERT INTO sessions(token_hash,account_id,expires_at,mfa_verified) VALUES(?,?,?,1)",
      )
      .run(tokenHash(token), owner.id, Date.now() + 60_000);
    const ownerCookie = `shopmate_admin=${token}`;
    const changed = await post("/api/admin/merchant", body, ownerCookie);
    expect(changed.status).toBe(200);
    expect((await changed.json()).version).toBe(2);
    expect(
      (await (await post("/api/admin/merchant", body, ownerCookie)).json())
        .version,
    ).toBe(2);
    expect(
      (
        await post(
          "/api/admin/merchant",
          { ...body, requestId: crypto.randomUUID() },
          ownerCookie,
        )
      ).status,
    ).toBe(409);
    const policyChanged = {
      ...readMerchant(sql),
      privacy: { ...readMerchant(sql).privacy, text: "不同内容" },
    };
    expect(
      (
        await post(
          "/api/admin/merchant",
          { merchant: policyChanged, requestId: crypto.randomUUID() },
          ownerCookie,
        )
      ).status,
    ).toBe(400);
  });
  it("requires a single-use verified contact and the current published policies, and preserves proof on transaction failure", async () => {
    expect((await post("/api/auth/register", input)).status).toBe(400);
    const verificationToken = await proof("register", "alice@example.test");
    const body = {
      ...input,
      verificationToken,
      privacyVersion: "old",
      termsVersion: "t1",
    };
    expect((await post("/api/auth/register", body)).status).toBe(409);
    expect(
      sql.prepare("SELECT count(*) n FROM accounts WHERE role='user'").get()!.n,
    ).toBe(0);
    const response = await post("/api/auth/register", {
      ...body,
      privacyVersion: "p1",
    });
    expect(response.status).toBe(201);
    const account = await response.json();
    expect(account).toMatchObject({ name: input.name, role: "user" });
    expect(() => requireVerifiedContact(sql, account.id)).not.toThrow();
    expect(
      sql
        .prepare("SELECT target FROM verified_contacts WHERE account_id=?")
        .get(account.id)?.target,
    ).toBe("alice@example.test");
    expect(
      sql
        .prepare(
          "SELECT status,account_id FROM verification_challenges WHERE account_id=?",
        )
        .get(account.id),
    ).toMatchObject({ status: "consumed", account_id: account.id });
    expect(
      (
        await post("/api/auth/register", {
          ...body,
          username: "another",
          privacyVersion: "p1",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(base + "/test/session/user", {
          headers: { Cookie: cookieOf(response) },
        })
      ).status,
    ).toBe(200);
  });
  it("commits invalid-code attempt limits and rejects expired or delivery-failed challenges", async () => {
    const response = await post("/api/auth/verification/send", {
      channel: "phone",
      target: "13800000001",
      purpose: "register",
    });
    const { challengeId } = await response.json(),
      delivery = sent[0]!;
    const wrong = delivery.code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++)
      expect(
        (
          await post("/api/auth/verification/verify", {
            challengeId,
            code: wrong,
          })
        ).status,
      ).toBe(400);
    expect(
      sql
        .prepare("SELECT attempts FROM verification_challenges WHERE id=?")
        .get(challengeId)?.attempts,
    ).toBe(5);
    expect(
      (
        await post("/api/auth/verification/verify", {
          challengeId,
          code: delivery.code,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post("/api/auth/verification/send", {
          channel: "phone",
          target: "13800000001",
          purpose: "register",
        })
      ).status,
    ).toBe(429);
    deliveryFails = true;
    expect(
      (
        await post("/api/auth/verification/send", {
          channel: "email",
          target: "failed@example.test",
          purpose: "register",
        })
      ).status,
    ).toBe(503);
    expect(
      sql
        .prepare("SELECT status FROM verification_challenges WHERE target=?")
        .get("failed@example.test")?.status,
    ).toBe("failed");
    sql
      .prepare("UPDATE verification_challenges SET expires_at=?")
      .run(Date.now() - 1);
    cleanupAccountChallenges(sql);
    expect(
      sql.prepare("SELECT count(*) n FROM verification_challenges").get()!.n,
    ).toBe(0);
  });
  it("binds only to the logged-in account and recovers using the current verified target, revoking every old session", async () => {
    const { cookie, account } = await register();
    const token = await proof("bind", "new@example.test", cookie);
    expect(
      (
        await post(
          "/api/auth/contacts",
          { verificationToken: token, password: "wrong" },
          cookie,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await post(
          "/api/auth/contacts",
          { verificationToken: token, password: input.password },
          cookie,
        )
      ).status,
    ).toBe(200);
    const afterCooldown = Date.now() + 61_000;
    vi.spyOn(Date, "now").mockReturnValue(afterCooldown);
    const recoveryToken = await proof(
      "recover",
      "new@example.test",
      "",
      input.username,
    );
    expect(
      (
        await post("/api/auth/recover", {
          verificationToken: recoveryToken,
          newPassword: "NewPassword123!",
        })
      ).status,
    ).toBe(200);
    expect(
      sql
        .prepare("SELECT count(*) n FROM sessions WHERE account_id=?")
        .get(account.id)?.n,
    ).toBe(0);
    expect(
      (
        await post("/api/auth/login", {
          role: "user",
          username: input.username,
          password: input.password,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await post("/api/auth/login", {
          role: "user",
          username: input.username,
          password: "NewPassword123!",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post("/api/auth/recover", {
          verificationToken: recoveryToken,
          newPassword: "OtherPassword123!",
        })
      ).status,
    ).toBe(400);
  });
  it("exports own records, guards open business, anonymizes final records and disables the closed account", async () => {
    const { cookie, account } = await register();
    const exported = await post(
      "/api/auth/export",
      { password: input.password },
      cookie,
    );
    expect(exported.status).toBe(200);
    const data = await exported.json();
    expect(data.profile).toEqual({
      username: input.username,
      name: input.name,
    });
    expect(JSON.stringify(data)).not.toContain("scrypt$");
    const db = readDatabase(sql),
      order = structuredClone(createSeed().orders[0]!);
    order.userId = account.id;
    order.status = "pending";
    db.orders.push(order);
    db.revision++;
    writeDatabase(sql, db);
    const body = {
      password: input.password,
      confirmation: "注销账号",
      requestId: crypto.randomUUID(),
    };
    expect((await post("/api/auth/close", body, cookie)).status).toBe(409);
    const finalized = readDatabase(sql);
    finalized.orders[0]!.status = "completed";
    finalized.revision++;
    writeDatabase(sql, finalized);
    expect((await post("/api/auth/close", body, cookie)).status).toBe(200);
    expect(
      sql
        .prepare("SELECT active,name FROM accounts WHERE id=?")
        .get(account.id),
    ).toMatchObject({ active: 0, name: "已注销用户" });
    expect(
      sql
        .prepare("SELECT count(*) n FROM verified_contacts WHERE account_id=?")
        .get(account.id)?.n,
    ).toBe(0);
    expect(readDatabase(sql).orders[0]!.address.phone).toBe("");
    expect(
      (
        await post("/api/auth/login", {
          role: "user",
          username: input.username,
          password: input.password,
        })
      ).status,
    ).toBe(401);
  });
  it("requires MFA enrollment before issuing an admin session and rejects TOTP/recovery replays", async () => {
    const admin = await createAccount(
      sql,
      { ...input, username: "owner" },
      "admin",
    );
    const login = await post("/api/auth/login", {
      role: "admin",
      username: "owner",
      password: input.password,
    });
    expect(await login.json()).toEqual({ mfaRequired: true, enrollment: true });
    expect(
      sql
        .prepare("SELECT count(*) n FROM sessions WHERE account_id=?")
        .get(admin.id)?.n,
    ).toBe(0);
    const pending = cookieOf(login, "shopmate_mfa");
    const setup = await (
      await post("/api/auth/mfa/enroll", {}, pending)
    ).json();
    expect(setup.uri).toContain("otpauth://totp/");
    const code = await generate({ secret: setup.secret });
    const completed = await post("/api/auth/mfa/confirm", { code }, pending);
    expect(completed.status).toBe(200);
    const response = await completed.json();
    expect(response.recoveryCodes).toHaveLength(8);
    const session = cookieOf(completed, "shopmate_admin");
    expect(
      sql
        .prepare("SELECT mfa_verified FROM sessions WHERE token_hash=?")
        .get(tokenHash(session.split("=")[1]!))?.mfa_verified,
    ).toBe(1);
    expect(
      (
        await fetch(base + "/test/session/admin", {
          headers: { Cookie: session },
        })
      ).status,
    ).toBe(200);
    expect(
      (await post("/api/auth/mfa/confirm", { code }, pending)).status,
    ).toBe(401);
    const nextLogin = await post("/api/auth/login", {
      role: "admin",
      username: "owner",
      password: input.password,
    });
    expect(await nextLogin.json()).toEqual({
      mfaRequired: true,
      enrollment: false,
    });
    const nextPending = cookieOf(nextLogin, "shopmate_mfa");
    expect(
      (await post("/api/auth/mfa/verify", { code }, nextPending)).status,
    ).toBe(400);
    expect(
      (
        await post(
          "/api/auth/mfa/recovery",
          { code: response.recoveryCodes[0] },
          nextPending,
        )
      ).status,
    ).toBe(200);
    const thirdLogin = await post("/api/auth/login", {
      role: "admin",
      username: "owner",
      password: input.password,
    });
    expect(
      (
        await post(
          "/api/auth/mfa/recovery",
          { code: response.recoveryCodes[0] },
          cookieOf(thirdLogin, "shopmate_mfa"),
        )
      ).status,
    ).toBe(400);
    expect(
      JSON.stringify(sql.prepare("SELECT secret FROM account_mfa").get()),
    ).not.toContain(setup.secret);
    resetMfa(sql, "owner");
    expect(
      sql
        .prepare("SELECT count(*) n FROM sessions WHERE account_id=?")
        .get(admin.id)?.n,
    ).toBe(0);
    expect(sql.prepare("SELECT count(*) n FROM account_mfa").get()?.n).toBe(0);
  }, 20_000);
  it("cancels incomplete MFA challenges and exposes no account existence through recovery responses", async () => {
    await createAccount(sql, { ...input, username: "owner" }, "admin");
    const login = await post("/api/auth/login", {
      role: "admin",
      username: "owner",
      password: input.password,
    });
    const pending = cookieOf(login, "shopmate_mfa");
    expect((await post("/api/auth/mfa/cancel", {}, pending)).status).toBe(200);
    expect((await post("/api/auth/mfa/enroll", {}, pending)).status).toBe(401);
    const result = await post("/api/auth/verification/send", {
      channel: "email",
      target: "unknown@example.test",
      purpose: "recover",
      username: "nobody",
    });
    expect(result.status).toBe(202);
    expect(sent).toHaveLength(0);
  });
  it("invalidates a password-authorized MFA challenge when the password changes before its second factor", async () => {
    const admin = await createAccount(
      sql,
      { ...input, username: "owner" },
      "admin",
    );
    const login = await post("/api/auth/login", {
      role: "admin",
      username: "owner",
      password: input.password,
    });
    const pending = cookieOf(login, "shopmate_mfa");
    const setup = await (
      await post("/api/auth/mfa/enroll", {}, pending)
    ).json();
    sql
      .prepare("UPDATE accounts SET password_hash=? WHERE id=?")
      .run("invalidated-by-password-maintenance", admin.id);
    const confirmed = await post(
      "/api/auth/mfa/confirm",
      { code: await generate({ secret: setup.secret }) },
      pending,
    );
    expect(confirmed.status).toBe(401);
    expect(
      sql
        .prepare("SELECT count(*) n FROM sessions WHERE account_id=?")
        .get(admin.id)?.n,
    ).toBe(0);
    expect(
      sql
        .prepare("SELECT count(*) n FROM account_mfa WHERE account_id=?")
        .get(admin.id)?.n,
    ).toBe(0);
  });
});
