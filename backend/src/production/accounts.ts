import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { redactAccountDomain, redactLegacyAccount } from "./privacy";
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { generateSecret, generateURI, verify } from "otplib";
import {
  checkPassword,
  clearSession,
  findSession,
  hashPassword,
  issueSession,
  rateLimit,
  tokenFrom,
  tokenHash,
  type Account,
} from "../auth";
import {
  readDatabase,
  queryRecord,
  transaction,
  writeDatabase,
} from "../database";
import { HttpError } from "../errors";
import { audit } from "../runtime";
import { demand, grants, isStaffRole } from "../permissions";
import { loginSchema, passwordSchema, registerSchema } from "../validation";
import { seal, unseal } from "./config";
import type { Role, Session } from "../../../shared/domain/types";

type Channel = "email" | "phone";
export interface AccountOptions {
  production: boolean;
  secureCookies?: boolean;
  sessionTtl?: number;
  encryptionKey?: Buffer;
  emailEnabled: boolean;
  smsEnabled: boolean;
  sendVerification: (input: {
    channel: Channel;
    target: string;
    code: string;
    challengeId: string;
  }) => Promise<void>;
  assertClosable?: (accountId: string) => void;
  anonymizeAccount?: (accountId: string) => void;
  exportAccountData?: (accountId: string) => Record<string, unknown>;
}
type Contact = { channel: Channel; target: string };
type Challenge = {
  id: string;
  purpose: string;
  channel: Channel;
  target: string;
  account_id: string | null;
  code_hash: string;
  status: string;
  attempts: number;
  expires_at: number;
  proof_hash: string | null;
};
type MfaChallenge = {
  token_hash: string;
  account_id: string;
  password_hash: string;
  attempts: number;
  expires_at: number;
  secret: string | null;
};
const FIVE_MINUTES = 5 * 60_000;
const MFA_COOKIE = "shopmate_mfa";
const contactSchema = z
  .object({
    channel: z.enum(["email", "phone"]),
    target: z.string().trim().min(1).max(254),
  })
  .strict();
const codeSchema = z.string().regex(/^\d{6}$/, "验证码为六位数字");
const policySchema = z
  .object({
    version: z.string().trim().max(80),
    title: z.string().trim().max(120),
    text: z.string().trim().max(30_000),
  })
  .strict();
const merchantSchema = z
  .object({
    version: z.number().int().positive(),
    legalName: z.string().trim().max(120),
    serviceEmail: z.union([z.email().max(254), z.literal("")]),
    servicePhone: z.string().trim().max(30),
    returnAddress: z.string().trim().max(500),
    privacy: policySchema,
    terms: policySchema,
  })
  .strict();
export type Merchant = z.infer<typeof merchantSchema>;
const defaultMerchant: Merchant = {
  version: 1,
  legalName: "",
  serviceEmail: "",
  servicePhone: "",
  returnAddress: "",
  privacy: { version: "", title: "隐私政策", text: "" },
  terms: { version: "", title: "服务协议", text: "" },
};

export function ensureAccountSchema(sql: DatabaseSync) {
  if (
    !sql
      .prepare("PRAGMA table_info(accounts)")
      .all()
      .some((row) => row.name === "active")
  )
    sql.exec(
      "ALTER TABLE accounts ADD COLUMN active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))",
    );
  if (
    !sql
      .prepare("PRAGMA table_info(sessions)")
      .all()
      .some((row) => row.name === "mfa_verified")
  )
    sql.exec(
      "ALTER TABLE sessions ADD COLUMN mfa_verified INTEGER NOT NULL DEFAULT 0 CHECK(mfa_verified IN (0,1))",
    );
  sql.exec(`
    CREATE TABLE IF NOT EXISTS verified_contacts(account_id TEXT NOT NULL REFERENCES accounts(id),channel TEXT NOT NULL CHECK(channel IN ('email','phone')),target TEXT NOT NULL,verified_at INTEGER NOT NULL,PRIMARY KEY(account_id,channel),UNIQUE(channel,target));
    CREATE TABLE IF NOT EXISTS verification_challenges(id TEXT PRIMARY KEY,purpose TEXT NOT NULL CHECK(purpose IN ('register','bind','recover')),channel TEXT NOT NULL CHECK(channel IN ('email','phone')),target TEXT NOT NULL,account_id TEXT REFERENCES accounts(id),code_hash TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('sending','sent','failed','verified','consumed')),attempts INTEGER NOT NULL DEFAULT 0,expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL,proof_hash TEXT UNIQUE);
    CREATE INDEX IF NOT EXISTS verification_target_time ON verification_challenges(channel,target,created_at DESC);
    CREATE INDEX IF NOT EXISTS verification_expiry ON verification_challenges(expires_at);
    CREATE TABLE IF NOT EXISTS account_mfa(account_id TEXT PRIMARY KEY REFERENCES accounts(id),secret TEXT NOT NULL,last_step INTEGER NOT NULL DEFAULT -1,enabled_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS mfa_recovery_codes(account_id TEXT NOT NULL REFERENCES accounts(id),code_hash TEXT NOT NULL,PRIMARY KEY(account_id,code_hash));
    CREATE TABLE IF NOT EXISTS mfa_challenges(token_hash TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),password_hash TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,expires_at INTEGER NOT NULL,secret TEXT);
    CREATE INDEX IF NOT EXISTS mfa_challenge_expiry ON mfa_challenges(expires_at);
    CREATE TABLE IF NOT EXISTS merchant_profile(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL CHECK(json_valid(data)));
    CREATE TABLE IF NOT EXISTS merchant_policy_versions(kind TEXT NOT NULL CHECK(kind IN ('privacy','terms')),version TEXT NOT NULL,data TEXT CHECK(data IS NULL OR json_valid(data)),PRIMARY KEY(kind,version));
    CREATE TABLE IF NOT EXISTS policy_consents(account_id TEXT NOT NULL REFERENCES accounts(id),kind TEXT NOT NULL CHECK(kind IN ('privacy','terms')),version TEXT NOT NULL,accepted_at INTEGER NOT NULL,PRIMARY KEY(account_id,kind,version));
    CREATE TABLE IF NOT EXISTS account_requests(account_id TEXT NOT NULL,request_id TEXT NOT NULL,kind TEXT NOT NULL,fingerprint TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(account_id,request_id,kind));
  `);
  sql
    .prepare("INSERT OR IGNORE INTO merchant_profile VALUES(1,?)")
    .run(JSON.stringify(defaultMerchant));
  rememberPublishedPolicies(sql, readMerchant(sql));
  // Historic consent versions whose source text is unavailable must never acquire new text.
  sql.exec(
    "INSERT OR IGNORE INTO merchant_policy_versions(kind,version,data) SELECT DISTINCT kind,version,NULL FROM policy_consents",
  );
}

function rememberPublishedPolicies(sql: DatabaseSync, merchant: Merchant) {
  for (const kind of ["privacy", "terms"] as const) {
    const policy = merchant[kind];
    if (!policy.version || !policy.text) continue;
    const data = JSON.stringify({
      version: policy.version,
      title: policy.title,
      text: policy.text,
    });
    const existing = sql
      .prepare(
        "SELECT data FROM merchant_policy_versions WHERE kind=? AND version=?",
      )
      .get(kind, policy.version);
    if (existing && existing.data !== data)
      throw new HttpError(
        409,
        "该协议版本已有其他内容，请使用新版本号",
        "POLICY_VERSION_CONFLICT",
      );
    sql
      .prepare("INSERT OR IGNORE INTO merchant_policy_versions VALUES(?,?,?)")
      .run(kind, policy.version, data);
  }
}

export function readMerchant(sql: DatabaseSync): Merchant {
  return JSON.parse(
    String(
      sql.prepare("SELECT data FROM merchant_profile WHERE id=1").get()!.data,
    ),
  ) as Merchant;
}
export function isAccountActive(sql: DatabaseSync, id: string) {
  return (
    sql.prepare("SELECT active FROM accounts WHERE id=?").get(id)?.active === 1
  );
}
export function contactsFor(sql: DatabaseSync, accountId: string): Contact[] {
  return sql
    .prepare(
      "SELECT channel,target FROM verified_contacts WHERE account_id=? ORDER BY channel",
    )
    .all(accountId) as unknown as Contact[];
}
export function requireVerifiedContact(sql: DatabaseSync, accountId: string) {
  if (!isAccountActive(sql, accountId))
    throw new HttpError(401, "账号已停用，请重新登录", "ACCOUNT_DISABLED");
  if (
    !sql
      .prepare("SELECT 1 FROM verified_contacts WHERE account_id=?")
      .get(accountId)
  )
    throw new HttpError(
      403,
      "请先在账号安全中验证邮箱或手机号",
      "VERIFIED_CONTACT_REQUIRED",
    );
  const merchant = readMerchant(sql);
  for (const kind of ["privacy", "terms"] as const)
    if (
      !merchant[kind].version ||
      !sql
        .prepare(
          "SELECT 1 FROM policy_consents WHERE account_id=? AND kind=? AND version=?",
        )
        .get(accountId, kind, merchant[kind].version)
    )
      throw new HttpError(
        403,
        "请在账号安全中阅读并同意当前隐私政策和服务协议",
        "POLICY_CONSENT_REQUIRED",
      );
}
function normalizeContact(input: Contact): Contact {
  if (input.channel === "email")
    return {
      channel: "email",
      target: z.email().max(254).parse(input.target.toLowerCase()),
    };
  return {
    channel: "phone",
    target: z
      .string()
      .regex(/^1[3-9]\d{9}$/, "请输入中国大陆手机号")
      .parse(input.target.replace(/^\+86/, "")),
  };
}
function mac(key: Buffer, value: string) {
  return createHmac("sha256", key).update(value).digest("hex");
}
function same(a: string, b: string) {
  return (
    a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
  );
}
function accountSession(sql: DatabaseSync, req: Request, role: Role = "user") {
  const session = findSession(sql, req, role);
  if (!session || !isAccountActive(sql, session.id))
    throw new HttpError(401, "登录已失效，请重新登录");
  return session;
}
function currentAccount(sql: DatabaseSync, id: string) {
  const account = sql
    .prepare("SELECT * FROM accounts WHERE id=? AND active=1")
    .get(id) as unknown as Account | undefined;
  if (!account) throw new HttpError(401, "账号不可用");
  return account;
}
function assertPasswordCurrent(sql: DatabaseSync, account: Account) {
  if (
    sql
      .prepare("SELECT password_hash FROM accounts WHERE id=? AND active=1")
      .get(account.id)?.password_hash !== account.password_hash
  )
    throw new HttpError(409, "账号状态已更新，请重新验证");
}
function consent(
  sql: DatabaseSync,
  accountId: string,
  input: { privacyVersion: string; termsVersion: string },
) {
  const merchant = readMerchant(sql);
  if (
    !merchant.legalName ||
    !merchant.returnAddress ||
    !merchant.privacy.version ||
    !merchant.privacy.text ||
    !merchant.terms.version ||
    !merchant.terms.text ||
    (!merchant.servicePhone && !merchant.serviceEmail)
  )
    throw new HttpError(
      503,
      "商家尚未发布完整经营资料和协议",
      "MERCHANT_NOT_READY",
    );
  if (
    input.privacyVersion !== merchant.privacy.version ||
    input.termsVersion !== merchant.terms.version
  )
    throw new HttpError(409, "协议已更新，请阅读后重新确认", "POLICY_CHANGED");
  rememberPublishedPolicies(sql, merchant);
  for (const kind of ["privacy", "terms"] as const)
    sql
      .prepare("INSERT OR IGNORE INTO policy_consents VALUES(?,?,?,?)")
      .run(accountId, kind, merchant[kind].version, Date.now());
}
function consumeProof(
  sql: DatabaseSync,
  proof: string,
  purpose: string,
  accountId?: string,
): Challenge {
  const challenge = sql
    .prepare(
      "SELECT * FROM verification_challenges WHERE proof_hash=? AND purpose=?",
    )
    .get(tokenHash(proof), purpose) as unknown as Challenge | undefined;
  if (
    !challenge ||
    challenge.status !== "verified" ||
    challenge.expires_at <= Date.now() ||
    (accountId !== undefined && challenge.account_id !== accountId)
  )
    throw new HttpError(
      400,
      "验证凭证已失效，请重新验证",
      "VERIFICATION_EXPIRED",
    );
  const changed = sql
    .prepare(
      "UPDATE verification_challenges SET status='consumed',proof_hash=NULL WHERE id=? AND status='verified'",
    )
    .run(challenge.id);
  if (changed.changes !== 1) throw new HttpError(409, "验证凭证已使用");
  return challenge;
}
function safeContact(contact: Contact) {
  return {
    channel: contact.channel,
    masked:
      contact.channel === "phone"
        ? `${contact.target.slice(0, 3)}****${contact.target.slice(-4)}`
        : `${contact.target[0]}***@${contact.target.split("@")[1]}`,
  };
}
function mfaToken(req: Request) {
  return (
    (req.headers.cookie ?? "")
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith(`${MFA_COOKIE}=`))
      ?.slice(MFA_COOKIE.length + 1) ?? ""
  );
}
function mfaChallenge(sql: DatabaseSync, req: Request): MfaChallenge {
  const challenge = sql
    .prepare("SELECT * FROM mfa_challenges WHERE token_hash=?")
    .get(tokenHash(mfaToken(req))) as unknown as MfaChallenge | undefined;
  if (
    !challenge ||
    challenge.expires_at <= Date.now() ||
    challenge.attempts >= 5
  )
    throw new HttpError(
      401,
      "二次验证已过期，请重新输入密码",
      "MFA_CHALLENGE_EXPIRED",
    );
  const account = currentAccount(sql, challenge.account_id);
  if (
    account.password_hash !== challenge.password_hash ||
    sql
      .prepare("SELECT active FROM staff_access WHERE account_id=?")
      .get(account.id)?.active !== 1
  )
    throw new HttpError(401, "账号状态已变更，请重新登录");
  return challenge;
}
function clearMfa(res: Response, secure: boolean) {
  // Clear the old narrow path too, so it cannot shadow the auth-scoped challenge cookie.
  for (const path of ["/api/auth/mfa", "/api/auth"])
    res.clearCookie(MFA_COOKIE, {
      path,
      httpOnly: true,
      secure,
      sameSite: "strict",
    });
}
export function cancelMfaChallenge(
  sql: DatabaseSync,
  req: Request,
  res: Response,
  secure: boolean,
) {
  sql
    .prepare("DELETE FROM mfa_challenges WHERE token_hash=?")
    .run(tokenHash(mfaToken(req)));
  clearMfa(res, secure);
}
function mfaAccount(sql: DatabaseSync, id: string): Session {
  const account = currentAccount(sql, id);
  const access = sql
    .prepare("SELECT staff_role,active FROM staff_access WHERE account_id=?")
    .get(id);
  if (!access || access.active !== 1 || !isStaffRole(access.staff_role))
    throw new HttpError(403, "员工权限不可用");
  return {
    id,
    name: account.name,
    role: "admin",
    staffRole: access.staff_role,
    permissions: grants[access.staff_role],
  };
}
function completeMfa(
  sql: DatabaseSync,
  req: Request,
  res: Response,
  challenge: MfaChallenge,
  options: AccountOptions,
) {
  const latest = sql
    .prepare(
      "SELECT password_hash,expires_at FROM mfa_challenges WHERE token_hash=?",
    )
    .get(challenge.token_hash);
  if (
    !latest ||
    Number(latest.expires_at) <= Date.now() ||
    currentAccount(sql, challenge.account_id).password_hash !==
      latest.password_hash
  )
    throw new HttpError(401, "二次验证已失效，请重新登录");
  const account = mfaAccount(sql, challenge.account_id);
  issueSession(
    sql,
    req,
    res,
    account,
    options.secureCookies ?? true,
    options.sessionTtl ?? 8 * 60 * 60_000,
  );
  const issued = res.getHeader("Set-Cookie");
  const cookie = (Array.isArray(issued) ? issued : [String(issued)]).find(
    (value) => value.startsWith("shopmate_admin="),
  );
  const token = cookie?.split(";")[0]?.split("=")[1];
  if (!token) throw new Error("MFA_SESSION_NOT_ISSUED");
  sql
    .prepare("UPDATE sessions SET mfa_verified=1 WHERE token_hash=?")
    .run(tokenHash(token));
  sql
    .prepare("DELETE FROM mfa_challenges WHERE token_hash=?")
    .run(challenge.token_hash);
  sql
    .prepare("DELETE FROM rate_limits WHERE key=?")
    .run(
      `login-account:admin:${currentAccount(sql, challenge.account_id).username}`,
    );
  clearMfa(res, options.secureCookies ?? true);
  return account;
}

export function registerAccountRoutes(
  app: Express,
  sql: DatabaseSync,
  options: AccountOptions,
) {
  ensureAccountSchema(sql);
  const channels: Channel[] = [
    ...(options.emailEnabled ? ["email" as const] : []),
    ...(options.smsEnabled ? ["phone" as const] : []),
  ];
  const secure = options.secureCookies ?? false;
  const key = options.encryptionKey;
  const requireKey = () => {
    if (!key || key.length !== 32)
      throw new HttpError(
        503,
        "账号安全密钥未配置",
        "ACCOUNT_SECURITY_NOT_CONFIGURED",
      );
    return key;
  };
  const requireEnabled = () => {
    if (!options.production) throw new HttpError(404, "当前模式未启用此入口");
  };
  const dummyHashPromise = hashPassword(randomBytes(32).toString("hex"));

  app.get("/api/auth/production", (_req, res) =>
    res.json({
      production: options.production,
      channels,
      merchant: readMerchant(sql),
    }),
  );
  app.get("/api/merchant", (_req, res) => res.json(readMerchant(sql)));
  app.post("/api/admin/merchant", (req, res) => {
    const session = findSession(sql, req, "admin");
    demand(session, "settings");
    const { merchant, requestId } = z
      .object({
        merchant: merchantSchema,
        requestId: z.string().min(1).max(128),
      })
      .strict()
      .parse(req.body);
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(merchant))
      .digest("hex");
    const result = transaction(sql, () => {
      const previous = sql
        .prepare(
          "SELECT * FROM account_requests WHERE account_id=? AND request_id=? AND kind='merchant'",
        )
        .get(session!.id, requestId);
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new HttpError(409, "请求标识已用于其他内容");
        return JSON.parse(String(previous.result));
      }
      const old = readMerchant(sql);
      if (old.version !== merchant.version)
        throw new HttpError(409, "商家资料已更新，请刷新后修改");
      for (const kind of ["privacy", "terms"] as const)
        if (
          old[kind].version &&
          old[kind].text !== merchant[kind].text &&
          old[kind].version === merchant[kind].version
        )
          throw new HttpError(400, "修改协议内容必须更新协议版本");
      rememberPublishedPolicies(sql, old);
      rememberPublishedPolicies(sql, merchant);
      const next = { ...merchant, version: merchant.version + 1 };
      sql
        .prepare("UPDATE merchant_profile SET data=? WHERE id=1")
        .run(JSON.stringify(next));
      sql
        .prepare("INSERT INTO account_requests VALUES(?,?,'merchant',?,?)")
        .run(session!.id, requestId, fingerprint, JSON.stringify(next));
      audit(sql, session!.id, "merchant.update", requestId, "ok");
      return next;
    });
    res.json(result);
  });

  app.post("/api/auth/verification/send", async (req, res) => {
    requireEnabled();
    const input = z
      .object({
        channel: contactSchema.shape.channel,
        target: contactSchema.shape.target,
        purpose: z.enum(["register", "bind", "recover"]),
        username: z.string().trim().max(32).optional(),
      })
      .strict()
      .parse(req.body);
    const contact = normalizeContact(input);
    if (!channels.includes(contact.channel))
      throw new HttpError(
        503,
        "该验证渠道尚未配置",
        "VERIFICATION_CHANNEL_UNAVAILABLE",
      );
    const hmacKey = requireKey();
    rateLimit(sql, `verification-ip:${req.ip}`, 10, 15 * 60_000);
    rateLimit(
      sql,
      `verification-target:${contact.channel}:${tokenHash(contact.target)}`,
      10,
      24 * 60 * 60_000,
    );
    rateLimit(
      sql,
      `verification-global:${new Date().toISOString().slice(0, 10)}`,
      100,
      24 * 60 * 60_000,
    );
    let accountId: string | null = null;
    if (input.purpose === "bind") accountId = accountSession(sql, req).id;
    if (input.purpose === "recover") {
      const row = sql
        .prepare(
          "SELECT a.id FROM accounts a JOIN verified_contacts c ON c.account_id=a.id WHERE a.username=? AND a.role='user' AND a.active=1 AND c.channel=? AND c.target=?",
        )
        .get(
          input.username?.toLowerCase() ?? "",
          contact.channel,
          contact.target,
        );
      accountId = row ? String(row.id) : null;
    }
    const latest = sql
      .prepare(
        "SELECT created_at FROM verification_challenges WHERE channel=? AND target=? ORDER BY created_at DESC LIMIT 1",
      )
      .get(contact.channel, contact.target);
    if (latest && Number(latest.created_at) + 60_000 > Date.now())
      throw new HttpError(429, "请在六十秒后重新获取验证码");
    const challengeId = randomUUID(),
      code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const deliver = input.purpose !== "recover" || accountId !== null;
    sql
      .prepare(
        "INSERT INTO verification_challenges VALUES(?,?,?,?,?,?,'sending',0,?,?,NULL)",
      )
      .run(
        challengeId,
        input.purpose,
        contact.channel,
        contact.target,
        accountId,
        mac(hmacKey, `${challengeId}:${code}`),
        Date.now() + FIVE_MINUTES,
        Date.now(),
      );
    try {
      if (deliver)
        await options.sendVerification({ ...contact, code, challengeId });
      sql
        .prepare("UPDATE verification_challenges SET status='sent' WHERE id=?")
        .run(challengeId);
    } catch {
      sql
        .prepare(
          "UPDATE verification_challenges SET status='failed' WHERE id=?",
        )
        .run(challengeId);
      throw new HttpError(
        503,
        "验证码发送失败，请稍后重新申请",
        "VERIFICATION_DELIVERY_FAILED",
      );
    }
    res.status(202).json({
      challengeId,
      expiresIn: 300,
      retryAfter: 60,
      message: "符合条件的联系方式将收到验证码",
    });
  });
  app.post("/api/auth/verification/verify", (req, res) => {
    requireEnabled();
    const { challengeId, code } = z
      .object({ challengeId: z.uuid(), code: codeSchema })
      .strict()
      .parse(req.body);
    rateLimit(sql, `verification-check-ip:${req.ip}`, 30, 15 * 60_000);
    const proof = randomBytes(32).toString("hex");
    // Attempts must commit even when the code is wrong; throwing inside this transaction would roll them back.
    const accepted = transaction(sql, () => {
      const challenge = sql
        .prepare("SELECT * FROM verification_challenges WHERE id=?")
        .get(challengeId) as unknown as Challenge | undefined;
      if (
        !challenge ||
        challenge.status !== "sent" ||
        challenge.attempts >= 5 ||
        challenge.expires_at <= Date.now()
      )
        return false;
      if (
        challenge.purpose === "bind" &&
        findSession(sql, req, "user")?.id !== challenge.account_id
      )
        return false;
      sql
        .prepare(
          "UPDATE verification_challenges SET attempts=attempts+1 WHERE id=?",
        )
        .run(challengeId);
      if (
        !same(challenge.code_hash, mac(requireKey(), `${challengeId}:${code}`))
      )
        return false;
      sql
        .prepare(
          "UPDATE verification_challenges SET status='verified',proof_hash=? WHERE id=?",
        )
        .run(tokenHash(proof), challengeId);
      return true;
    });
    if (!accepted)
      throw new HttpError(
        400,
        "验证码错误、次数已用尽或已过期",
        "VERIFICATION_INVALID",
      );
    res.json({ verificationToken: proof });
  });
  app.post("/api/auth/register", async (req, res, next) => {
    if (!options.production) return next();
    rateLimit(sql, `register:${req.ip}`, 10, 60 * 60_000);
    const input = registerSchema
      .extend({
        verificationToken: z.string().length(64),
        privacyVersion: z.string().min(1).max(80),
        termsVersion: z.string().min(1).max(80),
      })
      .strict()
      .parse(req.body);
    const passwordHash = await hashPassword(input.password),
      id = randomUUID();
    const account = transaction(sql, () => {
      if (
        sql
          .prepare("SELECT 1 FROM accounts WHERE username=?")
          .get(input.username)
      )
        throw new HttpError(409, "该账号已被注册");
      const challenge = consumeProof(sql, input.verificationToken, "register");
      if (
        sql
          .prepare(
            "SELECT 1 FROM verified_contacts WHERE channel=? AND target=?",
          )
          .get(challenge.channel, challenge.target)
      )
        throw new HttpError(409, "该联系方式已绑定其他账号");
      sql
        .prepare(
          "INSERT INTO accounts(id,username,name,role,password_hash,created_at) VALUES(?,?,?,'user',?,?)",
        )
        .run(id, input.username, input.name, passwordHash, Date.now());
      sql
        .prepare("UPDATE verification_challenges SET account_id=? WHERE id=?")
        .run(id, challenge.id);
      consent(sql, id, input);
      sql
        .prepare("INSERT INTO verified_contacts VALUES(?,?,?,?)")
        .run(id, challenge.channel, challenge.target, Date.now());
      const db = readDatabase(sql);
      db.users.push({ id, username: input.username, name: input.name });
      db.favorites[id] = [];
      db.revision++;
      writeDatabase(sql, db);
      audit(sql, id, "account.register", randomUUID(), "ok");
      return { id, name: input.name, role: "user" as const };
    });
    issueSession(
      sql,
      req,
      res,
      account,
      secure,
      options.sessionTtl ?? 8 * 60 * 60_000,
    );
    res.status(201).json(account);
  });
  app.post("/api/auth/login", async (req, res, next) => {
    if (!options.production) return next();
    const input = loginSchema.parse(req.body);
    rateLimit(sql, `login-ip:${req.ip}`, 60, 15 * 60_000);
    const limitKey = `login-account:${input.role}:${input.username}`;
    rateLimit(sql, limitKey, 10, 15 * 60_000);
    const account = sql
      .prepare(
        "SELECT * FROM accounts WHERE username=? AND role=? AND active=1",
      )
      .get(input.username, input.role) as unknown as Account | undefined;
    const valid = await checkPassword(
      input.password,
      account?.password_hash ?? (await dummyHashPromise),
    );
    if (!account || !valid) throw new HttpError(401, "账号或密码错误");
    assertPasswordCurrent(sql, account);
    if (input.role === "admin") {
      requireKey();
      mfaAccount(sql, account.id);
      const token = randomBytes(32).toString("hex");
      sql
        .prepare(
          "DELETE FROM mfa_challenges WHERE expires_at<=? OR account_id=?",
        )
        .run(Date.now(), account.id);
      sql
        .prepare("INSERT INTO mfa_challenges VALUES(?,?,?,0,?,NULL)")
        .run(
          tokenHash(token),
          account.id,
          account.password_hash,
          Date.now() + FIVE_MINUTES,
        );
      clearSession(sql, req, res, "admin", secure);
      clearMfa(res, secure);
      res.cookie(MFA_COOKIE, token, {
        httpOnly: true,
        secure,
        sameSite: "strict",
        path: "/api/auth",
        maxAge: FIVE_MINUTES,
      });
      return void res.json({
        mfaRequired: true,
        enrollment: !sql
          .prepare("SELECT 1 FROM account_mfa WHERE account_id=?")
          .get(account.id),
      });
    }
    sql.prepare("DELETE FROM rate_limits WHERE key=?").run(limitKey);
    const session = {
      id: account.id,
      name: account.name,
      role: "user" as const,
    };
    issueSession(
      sql,
      req,
      res,
      session,
      secure,
      options.sessionTtl ?? 8 * 60 * 60_000,
    );
    res.json(session);
  });
  app.get("/api/auth/mfa/status", (req, res) => {
    requireEnabled();
    const challenge = mfaChallenge(sql, req);
    res.json({
      enrollment: !sql
        .prepare("SELECT 1 FROM account_mfa WHERE account_id=?")
        .get(challenge.account_id),
    });
  });
  app.post("/api/auth/mfa/enroll", (req, res) => {
    requireEnabled();
    const challenge = mfaChallenge(sql, req);
    if (
      sql
        .prepare("SELECT 1 FROM account_mfa WHERE account_id=?")
        .get(challenge.account_id)
    )
      throw new HttpError(409, "该账号已启用二次验证");
    const secret = challenge.secret
      ? unseal(challenge.secret, requireKey())
      : generateSecret();
    if (!challenge.secret)
      sql
        .prepare("UPDATE mfa_challenges SET secret=? WHERE token_hash=?")
        .run(seal(secret, requireKey()), challenge.token_hash);
    const username = String(
      sql
        .prepare("SELECT username FROM accounts WHERE id=?")
        .get(challenge.account_id)!.username,
    );
    res.json({
      secret,
      uri: generateURI({ issuer: "ShopMate-AI", label: username, secret }),
    });
  });
  app.post("/api/auth/mfa/confirm", async (req, res) => {
    requireEnabled();
    const { code } = z.object({ code: codeSchema }).strict().parse(req.body),
      challenge = mfaChallenge(sql, req);
    if (!challenge.secret) throw new HttpError(400, "请先获取二次验证设置");
    sql
      .prepare(
        "UPDATE mfa_challenges SET attempts=attempts+1 WHERE token_hash=?",
      )
      .run(challenge.token_hash);
    const verified = await verify({
      secret: unseal(challenge.secret, requireKey()),
      token: code,
      epochTolerance: 30,
    });
    if (!verified.valid || !("timeStep" in verified))
      throw new HttpError(400, "二次验证码错误");
    const codes = Array.from({ length: 8 }, () =>
      randomBytes(10).toString("hex"),
    );
    transaction(sql, () => {
      const latest = sql
        .prepare(
          "SELECT * FROM mfa_challenges WHERE token_hash=? AND expires_at>?",
        )
        .get(challenge.token_hash, Date.now()) as unknown as
        MfaChallenge | undefined;
      if (
        !latest ||
        currentAccount(sql, latest.account_id).password_hash !==
          latest.password_hash
      )
        throw new HttpError(401, "二次验证已失效，请重新登录");
      if (
        sql
          .prepare("SELECT 1 FROM account_mfa WHERE account_id=?")
          .get(latest.account_id)
      )
        throw new HttpError(409, "二次验证已经启用");
      sql
        .prepare("INSERT INTO account_mfa VALUES(?,?,?,?)")
        .run(latest.account_id, latest.secret!, verified.timeStep, Date.now());
      for (const recoveryCode of codes)
        sql
          .prepare("INSERT INTO mfa_recovery_codes VALUES(?,?)")
          .run(latest.account_id, tokenHash(recoveryCode));
      audit(sql, latest.account_id, "mfa.enroll", randomUUID(), "ok");
    });
    const account = completeMfa(sql, req, res, challenge, options);
    res.json({ account, recoveryCodes: codes });
  });
  app.post("/api/auth/mfa/verify", async (req, res) => {
    requireEnabled();
    const { code } = z.object({ code: codeSchema }).strict().parse(req.body),
      challenge = mfaChallenge(sql, req);
    sql
      .prepare(
        "UPDATE mfa_challenges SET attempts=attempts+1 WHERE token_hash=?",
      )
      .run(challenge.token_hash);
    const mfa = sql
      .prepare("SELECT secret,last_step FROM account_mfa WHERE account_id=?")
      .get(challenge.account_id);
    if (!mfa) throw new HttpError(400, "请先设置二次验证");
    const result = await verify({
      secret: unseal(String(mfa.secret), requireKey()),
      token: code,
      epochTolerance: 30,
      afterTimeStep: Number(mfa.last_step),
    });
    if (!result.valid || !("timeStep" in result))
      throw new HttpError(400, "二次验证码错误或本时段验证码已使用");
    const step = result.timeStep;
    const accepted = sql
      .prepare(
        "UPDATE account_mfa SET last_step=? WHERE account_id=? AND last_step<?",
      )
      .run(step, challenge.account_id, step);
    if (accepted.changes !== 1)
      throw new HttpError(409, "本时段验证码已使用，请等待下一组验证码");
    res.json({ account: completeMfa(sql, req, res, challenge, options) });
  });
  app.post("/api/auth/mfa/recovery", (req, res) => {
    requireEnabled();
    const { code } = z
        .object({ code: z.string().regex(/^[a-f0-9]{20}$/) })
        .strict()
        .parse(req.body),
      challenge = mfaChallenge(sql, req);
    sql
      .prepare(
        "UPDATE mfa_challenges SET attempts=attempts+1 WHERE token_hash=?",
      )
      .run(challenge.token_hash);
    if (
      sql
        .prepare(
          "DELETE FROM mfa_recovery_codes WHERE account_id=? AND code_hash=?",
        )
        .run(challenge.account_id, tokenHash(code)).changes !== 1
    )
      throw new HttpError(400, "恢复码错误或已使用");
    audit(sql, challenge.account_id, "mfa.recovery", randomUUID(), "ok");
    res.json({ account: completeMfa(sql, req, res, challenge, options) });
  });
  app.post("/api/auth/mfa/cancel", (req, res) => {
    cancelMfaChallenge(sql, req, res, secure);
    res.json({ ok: true });
  });

  app.get("/api/auth/contacts", (req, res) => {
    const session = accountSession(sql, req);
    res.json({
      contacts: contactsFor(sql, session.id).map(safeContact),
      channels,
    });
  });
  app.post("/api/auth/contacts", async (req, res) => {
    requireEnabled();
    const session = accountSession(sql, req),
      account = currentAccount(sql, session.id);
    const input = z
      .object({
        verificationToken: z.string().length(64),
        password: z.string().min(1).max(128),
      })
      .strict()
      .parse(req.body);
    rateLimit(sql, `contact-change:${session.id}`, 5, 15 * 60_000);
    if (!(await checkPassword(input.password, account.password_hash)))
      throw new HttpError(400, "当前密码错误");
    transaction(sql, () => {
      assertPasswordCurrent(sql, account);
      const challenge = consumeProof(
        sql,
        input.verificationToken,
        "bind",
        session.id,
      );
      const old = sql
        .prepare(
          "SELECT account_id FROM verified_contacts WHERE channel=? AND target=?",
        )
        .get(challenge.channel, challenge.target);
      if (old && old.account_id !== session.id)
        throw new HttpError(409, "该联系方式已绑定其他账号");
      sql
        .prepare(
          "INSERT INTO verified_contacts VALUES(?,?,?,?) ON CONFLICT(account_id,channel) DO UPDATE SET target=excluded.target,verified_at=excluded.verified_at",
        )
        .run(session.id, challenge.channel, challenge.target, Date.now());
      sql
        .prepare(
          "DELETE FROM verification_challenges WHERE account_id=? AND id<>?",
        )
        .run(session.id, challenge.id);
      audit(sql, session.id, "account.contact", randomUUID(), "ok");
    });
    res.json({ contacts: contactsFor(sql, session.id).map(safeContact) });
  });
  app.post("/api/auth/recover", async (req, res) => {
    requireEnabled();
    const input = z
      .object({
        verificationToken: z.string().length(64),
        newPassword: passwordSchema,
      })
      .strict()
      .parse(req.body);
    rateLimit(sql, `recover:${req.ip}`, 10, 15 * 60_000);
    const passwordHash = await hashPassword(input.newPassword);
    transaction(sql, () => {
      const challenge = consumeProof(sql, input.verificationToken, "recover");
      const accountId = challenge.account_id;
      if (
        !accountId ||
        !isAccountActive(sql, accountId) ||
        !sql
          .prepare(
            "SELECT 1 FROM verified_contacts WHERE account_id=? AND channel=? AND target=?",
          )
          .get(accountId, challenge.channel, challenge.target)
      )
        throw new HttpError(400, "验证凭证已失效，请重新验证");
      sql
        .prepare(
          "UPDATE accounts SET password_hash=? WHERE id=? AND role='user' AND active=1",
        )
        .run(passwordHash, accountId);
      sql.prepare("DELETE FROM sessions WHERE account_id=?").run(accountId);
      sql
        .prepare("DELETE FROM verification_challenges WHERE account_id=?")
        .run(accountId);
      audit(sql, accountId, "account.recover", randomUUID(), "ok");
    });
    clearSession(sql, req, res, "user", secure);
    res.json({ ok: true });
  });
  app.get("/api/auth/sessions", (req, res) => {
    const role = z
        .enum(["user", "admin"])
        .default("user")
        .parse(req.query.role),
      session = accountSession(sql, req, role),
      current = tokenHash(tokenFrom(req, role));
    const items = sql
      .prepare(
        "SELECT token_hash,expires_at FROM sessions WHERE account_id=? AND expires_at>? ORDER BY expires_at DESC",
      )
      .all(session.id, Date.now())
      .map((row) => ({
        id: row.token_hash,
        expiresAt: Number(row.expires_at),
        current: row.token_hash === current,
      }));
    res.json({ items });
  });
  app.post("/api/auth/sessions/revoke", (req, res) => {
    const input = z
        .object({
          id: z.string().length(64),
          role: z.enum(["user", "admin"]).default("user"),
        })
        .strict()
        .parse(req.body),
      session = accountSession(sql, req, input.role);
    sql
      .prepare("DELETE FROM sessions WHERE token_hash=? AND account_id=?")
      .run(input.id, session.id);
    if (input.id === tokenHash(tokenFrom(req, input.role)))
      clearSession(sql, req, res, input.role, secure);
    audit(sql, session.id, "account.session.revoke", randomUUID(), "ok");
    res.json({ ok: true });
  });
  app.post("/api/auth/consents", (req, res) => {
    const session = accountSession(sql, req),
      input = z
        .object({
          privacyVersion: z.string().min(1).max(80),
          termsVersion: z.string().min(1).max(80),
        })
        .strict()
        .parse(req.body);
    transaction(sql, () => consent(sql, session.id, input));
    res.json({ ok: true });
  });
  app.post("/api/auth/export", async (req, res) => {
    const session = accountSession(sql, req),
      account = currentAccount(sql, session.id),
      { password } = z
        .object({ password: z.string().min(1).max(128) })
        .strict()
        .parse(req.body);
    rateLimit(sql, `privacy:${session.id}`, 3, 60 * 60_000);
    if (!(await checkPassword(password, account.password_hash)))
      throw new HttpError(400, "当前密码错误");
    assertPasswordCurrent(sql, account);
    const personal: Record<string, unknown> = {
      profile: { username: account.username, name: account.name },
      contacts: contactsFor(sql, session.id),
      consents: sql
        .prepare(
          "SELECT kind,version,accepted_at FROM policy_consents WHERE account_id=?",
        )
        .all(session.id),
      favorites: queryRecord<string[]>(sql, "favorites", session.id) ?? [],
      ...(options.exportAccountData?.(session.id) ?? {}),
    };
    for (const domain of [
      "orders",
      "after_sales",
      "addresses",
      "carts",
      "conversations",
      "reviews",
      "notifications",
      "points_entries",
      "coupon_claims",
    ]) {
      const table = `biz_${domain}`;
      if (
        sql
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
          .get(table)
      )
        personal[domain] = sql
          .prepare(`SELECT data FROM ${table} WHERE user_id=? ORDER BY key`)
          .all(session.id)
          .map((row) => JSON.parse(String(row.data)));
    }
    audit(sql, session.id, "account.export", randomUUID(), "ok");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="shopmate-personal-data.json"',
    );
    res.json({ exportedAt: new Date().toISOString(), ...personal });
  });
  app.post("/api/auth/close", async (req, res) => {
    const session = accountSession(sql, req),
      account = currentAccount(sql, session.id),
      input = z
        .object({
          password: z.string().min(1).max(128),
          confirmation: z.literal("注销账号"),
          requestId: z.string().min(1).max(128),
        })
        .strict()
        .parse(req.body);
    rateLimit(sql, `account-close:${session.id}`, 5, 60 * 60_000);
    if (!(await checkPassword(input.password, account.password_hash)))
      throw new HttpError(400, "当前密码错误");
    const unusable = await hashPassword(randomBytes(32).toString("hex"));
    transaction(sql, () => {
      assertPasswordCurrent(sql, account);
      if (
        sql
          .prepare(
            "SELECT 1 FROM biz_orders WHERE user_id=? AND status NOT IN ('completed','cancelled','refunded')",
          )
          .get(session.id) ||
        sql
          .prepare(
            "SELECT 1 FROM biz_after_sales WHERE user_id=? AND status NOT IN ('refunded','rejected','cancelled')",
          )
          .get(session.id)
      )
        throw new HttpError(
          409,
          "请先完成订单和售后处理",
          "ACCOUNT_HAS_OPEN_BUSINESS",
        );
      options.assertClosable?.(session.id);
      const db = readDatabase(sql);
      const marker = `closed-${session.id}`;
      redactAccountDomain(db, session.id);
      const legacyRedaction = redactLegacyAccount(sql, session.id);
      if (legacyRedaction)
        audit(
          sql,
          session.id,
          "account.legacy-redact",
          input.requestId,
          "ok",
          `${legacyRedaction.before}:${legacyRedaction.after}`,
        );
      db.revision++;
      writeDatabase(sql, db);
      sql
        .prepare("DELETE FROM command_results WHERE actor_id=?")
        .run(session.id);
      if (
        sql
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='support_runs'",
          )
          .get()
      ) {
        sql
          .prepare(
            "UPDATE support_runs SET status=CASE WHEN status IN ('queued','running') THEN 'cancelled' ELSE status END,phase=CASE WHEN status IN ('queued','running') THEN 'cancelled' ELSE phase END,output=NULL WHERE user_id=?",
          )
          .run(session.id);
        sql
          .prepare(
            "DELETE FROM support_tool_calls WHERE run_id IN (SELECT id FROM support_runs WHERE user_id=?)",
          )
          .run(session.id);
        sql
          .prepare(
            "UPDATE support_proposals SET status=CASE WHEN status='pending' THEN 'cancelled' ELSE status END,args='{}',snapshot='{}',summary='',details='{}',result=NULL WHERE user_id=?",
          )
          .run(session.id);
      }
      sql
        .prepare("DELETE FROM verified_contacts WHERE account_id=?")
        .run(session.id);
      sql
        .prepare("DELETE FROM verification_challenges WHERE account_id=?")
        .run(session.id);
      sql.prepare("DELETE FROM sessions WHERE account_id=?").run(session.id);
      sql
        .prepare(
          "UPDATE accounts SET active=0,name='已注销用户',username=?,password_hash=? WHERE id=?",
        )
        .run(marker, unusable, session.id);
      options.anonymizeAccount?.(session.id);
      audit(sql, session.id, "account.close", input.requestId, "ok");
    });
    clearSession(sql, req, res, "user", secure);
    res.json({ ok: true });
  });
}

export function cleanupAccountChallenges(sql: DatabaseSync, at = Date.now()) {
  sql
    .prepare(
      "DELETE FROM verification_challenges WHERE id IN (SELECT id FROM verification_challenges WHERE expires_at<=? LIMIT 500)",
    )
    .run(at);
  sql
    .prepare(
      "DELETE FROM mfa_challenges WHERE token_hash IN (SELECT token_hash FROM mfa_challenges WHERE expires_at<=? LIMIT 500)",
    )
    .run(at);
}

/** Offline recovery requires deployment filesystem access and never prints a TOTP secret. */
export function resetMfa(sql: DatabaseSync, username: string) {
  const account = sql
    .prepare(
      "SELECT id FROM accounts WHERE username=? AND role='admin' AND active=1",
    )
    .get(username.toLowerCase());
  if (!account) throw new HttpError(404, "管理账号不存在");
  transaction(sql, () => {
    const id = String(account.id);
    sql.prepare("DELETE FROM sessions WHERE account_id=?").run(id);
    sql.prepare("DELETE FROM mfa_challenges WHERE account_id=?").run(id);
    sql.prepare("DELETE FROM mfa_recovery_codes WHERE account_id=?").run(id);
    sql.prepare("DELETE FROM account_mfa WHERE account_id=?").run(id);
    audit(sql, "offline-maintenance", "mfa.reset", randomUUID(), "ok", id);
  });
}
