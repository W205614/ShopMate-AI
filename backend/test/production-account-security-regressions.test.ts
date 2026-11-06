import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import type { Server } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { generate } from "otplib";
import { createApp } from "../src/app";
import { createAccount, tokenHash } from "../src/auth";
import { openDatabase } from "../src/database";
import {
  backupDatabase,
  inspectBackup,
  restoreBackup,
} from "../src/maintenance";
import {
  ensureAccountSchema,
  readMerchant,
  requireVerifiedContact,
  type AccountOptions,
} from "../src/production/accounts";
import { RegressionGateway } from "./support/payment-fixture";

let sql: DatabaseSync, server: Server, base: string, userId: string;
const password = "AccountSecurity123!";
const email = "security@example.test";
const headers = {
  "Content-Type": "application/json",
  "X-ShopMate-Request": "1",
};
const inbox: Parameters<AccountOptions["sendVerification"]>[0][] = [];
const cookieOf = (response: Response, name = "shopmate_user") =>
  response.headers
    .getSetCookie()
    .map((item) => item.split(";")[0]!)
    .find((value) => value.startsWith(`${name}=`) && !value.endsWith("=")) ??
  "";
function post(path: string, body: unknown, cookie = "") {
  return fetch(base + path, {
    method: "POST",
    headers: { ...headers, Cookie: cookie },
    body: JSON.stringify(body),
  });
}
async function login() {
  const response = await post("/api/auth/login", {
    role: "user",
    username: "security_user",
    password,
  });
  expect(response.status).toBe(200);
  return cookieOf(response);
}
async function proof(purpose: "recover" | "bind", target: string, cookie = "") {
  const sent = await post(
    "/api/auth/verification/send",
    {
      channel: "email",
      target,
      purpose,
      ...(purpose === "recover" ? { username: "security_user" } : {}),
    },
    cookie,
  );
  expect(sent.status).toBe(202);
  const { challengeId } = await sent.json();
  const delivered = inbox.find((item) => item.challengeId === challengeId)!;
  const verified = await post(
    "/api/auth/verification/verify",
    { challengeId, code: delivered.code },
    cookie,
  );
  expect(verified.status).toBe(200);
  return (await verified.json()).verificationToken as string;
}
async function ownerCookie() {
  const owner = await createAccount(
    sql,
    { username: "security_owner", name: "测试店主", password },
    "admin",
  );
  const token = randomBytes(32).toString("hex");
  sql
    .prepare(
      "INSERT INTO sessions(token_hash,account_id,expires_at,mfa_verified) VALUES(?,?,?,1)",
    )
    .run(tokenHash(token), owner.id, Date.now() + 60_000);
  return `shopmate_admin=${token}`;
}
beforeEach(async () => {
  for (const [name, value] of Object.entries({
    SHOP_MODE: "production",
    PUBLIC_URL: "https://security.example.test",
    ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    MONITOR_TOKEN: randomBytes(32).toString("hex"),
    PAYMENT_CHANNELS: "wechat_native",
    COOKIE_SECURE: "true",
    SMTP_HOST: "127.0.0.1",
    SMTP_FROM: "security@example.test",
    SMS_ENABLED: "false",
    KUAIDI100_ENABLED: "false",
    BACKUP_S3_ENABLED: "false",
    ALLOW_DEMO_RESET: "false",
    ALLOW_LEGACY_COMMANDS: "false",
    AI_ENABLED: "false",
  }))
    vi.stubEnv(name, value);
  inbox.length = 0;
  sql = openDatabase(":memory:");
  const app = await createApp(sql, {
    origins: ["https://security.example.test"],
    secureCookies: false,
    payments: {
      mode: "production",
      channels: ["wechat_native"],
      gateways: { wechatpay: new RegressionGateway() },
    },
    verificationSender: async (input) => {
      inbox.push(input);
    },
  });
  const merchant = {
    ...readMerchant(sql),
    legalName: "账号回归商家",
    serviceEmail: "support@example.test",
    returnAddress: "合成退货地址",
    privacy: { version: "p1", title: "隐私政策", text: "原始隐私正文" },
    terms: { version: "t1", title: "服务协议", text: "原始服务正文" },
  };
  sql
    .prepare("UPDATE merchant_profile SET data=? WHERE id=1")
    .run(JSON.stringify(merchant));
  ensureAccountSchema(sql);
  const user = await createAccount(sql, {
    username: "security_user",
    name: "账号回归顾客",
    password,
  });
  userId = user.id;
  sql
    .prepare("INSERT INTO verified_contacts VALUES(?,'email',?,?)")
    .run(userId, email, Date.now());
  sql
    .prepare(
      "INSERT INTO policy_consents VALUES(?,'privacy','p1',?), (?,'terms','t1',?)",
    )
    .run(userId, Date.now(), userId, Date.now());
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

describe("account security regressions through the real HTTP app", () => {
  it("invalidates an already verified recovery proof when the user changes their password", async () => {
    const cookie = await login();
    const verificationToken = await proof("recover", email);
    const nextPassword = "ChangedSecurity123!";
    expect(
      (
        await post(
          "/api/auth/password",
          { currentPassword: password, newPassword: nextPassword },
          cookie,
        )
      ).status,
    ).toBe(200);
    expect(
      sql
        .prepare(
          "SELECT count(*) n FROM verification_challenges WHERE account_id=?",
        )
        .get(userId)?.n,
    ).toBe(0);
    expect(
      (
        await post("/api/auth/recover", {
          verificationToken,
          newPassword: "StaleRecovery123!",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post("/api/auth/login", {
          role: "user",
          username: "security_user",
          password: nextPassword,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post("/api/auth/login", {
          role: "user",
          username: "security_user",
          password: "StaleRecovery123!",
        })
      ).status,
    ).toBe(401);
  });
  it("cancels a pending MFA login on admin logout and clears both challenge cookie paths", async () => {
    await createAccount(
      sql,
      { username: "security_owner", name: "测试店主", password },
      "admin",
    );
    const response = await post("/api/auth/login", {
      role: "admin",
      username: "security_owner",
      password,
    });
    expect(response.status).toBe(200);
    const challengeCookie = cookieOf(response, "shopmate_mfa");
    expect(
      response.headers
        .getSetCookie()
        .find((item) => item.startsWith(challengeCookie + ";")),
    ).toContain("Path=/api/auth;");
    const setup = await post("/api/auth/mfa/enroll", {}, challengeCookie);
    expect(setup.status).toBe(200);
    const { secret } = await setup.json();
    expect(
      (await post("/api/auth/logout", { role: "user" }, challengeCookie))
        .status,
    ).toBe(200);
    expect(sql.prepare("SELECT count(*) n FROM mfa_challenges").get()?.n).toBe(
      1,
    );
    const loggedOut = await post(
      "/api/auth/logout",
      { role: "admin" },
      challengeCookie,
    );
    expect(loggedOut.status).toBe(200);
    const cleared = loggedOut.headers
      .getSetCookie()
      .filter((item) => item.startsWith("shopmate_mfa=;"));
    expect(cleared.some((item) => item.includes("Path=/api/auth;"))).toBe(true);
    expect(cleared.some((item) => item.includes("Path=/api/auth/mfa;"))).toBe(
      true,
    );
    expect(
      (
        await post(
          "/api/auth/mfa/confirm",
          { code: await generate({ secret }) },
          challengeCookie,
        )
      ).status,
    ).toBe(401);
    expect(sql.prepare("SELECT count(*) n FROM account_mfa").get()?.n).toBe(0);
    expect(
      sql.prepare("SELECT count(*) n FROM sessions WHERE mfa_verified=1").get()
        ?.n,
    ).toBe(0);
  });
  it("keeps policy content immutable across version rollback and preserves it in verified backups and restore", async () => {
    const cookie = await ownerCookie();
    const update = (version: string, text: string) =>
      post(
        "/api/admin/merchant",
        {
          requestId: randomUUID(),
          merchant: {
            ...readMerchant(sql),
            privacy: { title: "隐私政策", version, text },
          },
        },
        cookie,
      );
    expect((await update("p2", "第二版隐私正文")).status).toBe(200);
    const reused = await update("p1", "使用旧版本号偷偷替换的正文");
    expect(reused.status).toBe(409);
    expect((await reused.json()).code).toBe("POLICY_VERSION_CONFLICT");
    expect(readMerchant(sql).privacy.version).toBe("p2");
    expect(() => requireVerifiedContact(sql, userId)).toThrow(
      "当前隐私政策和服务协议",
    );
    sql
      .prepare(
        "INSERT INTO policy_consents VALUES(?,'privacy','historic-unavailable',?)",
      )
      .run(userId, Date.now());
    ensureAccountSchema(sql);
    ensureAccountSchema(sql);
    expect(
      (await update("historic-unavailable", "不能重建未知历史正文")).status,
    ).toBe(409);
    const history = sql
      .prepare("SELECT * FROM merchant_policy_versions ORDER BY kind,version")
      .all();
    const parent = resolve(".e2e");
    mkdirSync(parent, { recursive: true });
    const directory = mkdtempSync(join(parent, "policy-history-"));
    const backup = join(directory, "policy.sqlite");
    const manifest = await backupDatabase(sql, backup);
    expect(manifest.counts.merchant_policy_versions).toBe(history.length);
    expect(manifest.digests.production).toBeTruthy();
    expect(inspectBackup(backup)).toEqual(manifest);
    expect((await update("p3", "第三版隐私正文")).status).toBe(200);
    const changed = await backupDatabase(
      sql,
      join(directory, "policy-next.sqlite"),
    );
    expect(changed.counts.merchant_policy_versions).toBe(history.length + 1);
    expect(changed.digests.production).not.toBe(manifest.digests.production);
    vi.stubEnv("CONFIRM_RESTORE", "STOPPED_AND_BACKED_UP");
    const target = join(directory, "restored.sqlite");
    await restoreBackup(backup, target, { offline: true });
    const restored = openDatabase(target);
    try {
      ensureAccountSchema(restored);
      expect(
        restored
          .prepare(
            "SELECT * FROM merchant_policy_versions ORDER BY kind,version",
          )
          .all(),
      ).toEqual(history);
      expect(readMerchant(restored).privacy.version).toBe("p2");
    } finally {
      restored.close();
    }
  });
  it("commits recovery, contact binding and closure once under concurrent proof replays", async () => {
    const verificationToken = await proof("recover", email);
    const body = { verificationToken, newPassword: "ConcurrentSecurity123!" };
    const reset = await Promise.all([
      post("/api/auth/recover", body),
      post("/api/auth/recover", body),
    ]);
    expect(reset.map((response) => response.status).sort()).toEqual([200, 400]);
    const loggedIn = await post("/api/auth/login", {
      role: "user",
      username: "security_user",
      password: body.newPassword,
    });
    expect(loggedIn.status).toBe(200);
    const cookie = cookieOf(loggedIn);
    const binding = {
      verificationToken: await proof("bind", "concurrent@example.test", cookie),
      password: body.newPassword,
    };
    const contacts = await Promise.all([
      post("/api/auth/contacts", binding, cookie),
      post("/api/auth/contacts", binding, cookie),
    ]);
    expect(contacts.map((response) => response.status).sort()).toEqual([
      200, 400,
    ]);
    expect(
      sql
        .prepare("SELECT target FROM verified_contacts WHERE account_id=?")
        .get(userId)?.target,
    ).toBe("concurrent@example.test");
    const closing = {
      password: body.newPassword,
      confirmation: "注销账号",
      requestId: randomUUID(),
    };
    const closed = await Promise.all([
      post("/api/auth/close", closing, cookie),
      post("/api/auth/close", closing, cookie),
    ]);
    expect(closed.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    expect(
      sql.prepare("SELECT active FROM accounts WHERE id=?").get(userId)?.active,
    ).toBe(0);
    expect(
      sql
        .prepare(
          "SELECT action,count(*) n FROM operation_audit WHERE actor_id=? AND action IN ('account.recover','account.contact','account.close') GROUP BY action ORDER BY action",
        )
        .all(userId)
        .map((row) => row.n),
    ).toEqual([1, 1, 1]);
  });
});
