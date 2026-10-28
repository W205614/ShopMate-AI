import {
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Request, Response } from "express";
import type { Role, Session } from "../../shared/domain/types";
import { readDatabase, transaction, writeDatabase } from "./database";
import { BoundedQueue, ensureRuntimeSchema } from "./runtime";
import { grants, isStaffRole } from "./permissions";
import type { StaffRole } from "../../shared/domain/operations";

import { HttpError } from "./errors";
export { HttpError } from "./errors";
export type Account = Session & { username: string; password_hash: string };
const options = { N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 };
export const passwordQueue = new BoundedQueue(2, 8);
const digest = (password: string, salt: string) =>
  passwordQueue.run(
    () =>
      new Promise<Buffer>((resolve, reject) =>
        scrypt(password, salt, 64, options, (error, key) =>
          error ? reject(error) : resolve(key),
        ),
      ),
  );
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `scrypt$${salt}$${(await digest(password, salt)).toString("hex")}`;
}
export async function commandFingerprint(
  actorId: string,
  method: string,
  requestId: string,
  args: unknown[],
) {
  const content = JSON.stringify(args);
  const password = (args[0] as { password?: unknown } | undefined)?.password;
  if (
    method === "saveStaff" &&
    typeof password === "string" &&
    password.length
  ) {
    // A fast hash of password-bearing arguments would bypass account scrypt on backup theft.
    // Bind the public salt to the idempotency namespace so concurrent retries agree.
    const salt = createHash("sha256")
      .update(JSON.stringify([actorId, method, requestId]))
      .digest("hex")
      .slice(0, 32);
    return `scrypt-command-v1$${salt}$${(await digest(content, salt)).toString("hex")}`;
  }
  return createHash("sha256").update(content).digest("hex");
}
export async function checkPassword(password: string, encoded: string) {
  const [, salt, hash] = encoded.split("$");
  if (!salt || !hash || !/^[a-f0-9]{128}$/.test(hash)) return false;
  const actual = await digest(password, salt);
  return timingSafeEqual(actual, Buffer.from(hash, "hex"));
}
export const tokenHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export const cookieName = (role: Role) => `shopmate_${role}`;
export function tokenFrom(req: Request, role: Role) {
  const cookie = (req.headers.cookie ?? "")
    .split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(`${cookieName(role)}=`));
  return cookie?.slice(cookie.indexOf("=") + 1) ?? "";
}
export function findSession(
  sql: DatabaseSync,
  req: Request,
  role: Role,
): Session | null {
  const row = sql
    .prepare(
      `SELECT a.id, a.name, a.role FROM sessions s JOIN accounts a ON a.id=s.account_id
    WHERE s.token_hash=? AND s.expires_at>? AND a.role=?`,
    )
    .get(tokenHash(tokenFrom(req, role)), Date.now(), role);
  if (!row) return null;
  const session = row as unknown as Session;
  if (role === "admin") {
    const access = sql
      .prepare("SELECT staff_role, active FROM staff_access WHERE account_id=?")
      .get(session.id) as { staff_role: StaffRole; active: number } | undefined;
    if (!access || access.active !== 1 || !isStaffRole(access.staff_role))
      return null;
    session.staffRole = access.staff_role;
    session.permissions = grants[session.staffRole];
  }
  return session;
}
export function issueSession(
  sql: DatabaseSync,
  req: Request,
  res: Response,
  account: Session,
  secure: boolean,
  ttl: number,
) {
  const token = randomBytes(32).toString("hex");
  transaction(sql, () => {
    sql
      .prepare("DELETE FROM sessions WHERE token_hash=? OR expires_at<=?")
      .run(tokenHash(tokenFrom(req, account.role)), Date.now());
    sql
      .prepare("INSERT INTO sessions VALUES (?, ?, ?)")
      .run(tokenHash(token), account.id, Date.now() + ttl);
  });
  res.cookie(cookieName(account.role), token, {
    httpOnly: true,
    sameSite: "strict",
    secure,
    path: "/",
    maxAge: ttl,
  });
}
export function clearSession(
  sql: DatabaseSync,
  req: Request,
  res: Response,
  role: Role,
  secure: boolean,
) {
  sql
    .prepare("DELETE FROM sessions WHERE token_hash=?")
    .run(tokenHash(tokenFrom(req, role)));
  res.clearCookie(cookieName(role), {
    httpOnly: true,
    sameSite: "strict",
    secure,
    path: "/",
  });
}
export function rateLimit(
  sql: DatabaseSync,
  key: string,
  limit: number,
  windowMs: number,
) {
  const now = Date.now();
  sql.prepare("DELETE FROM rate_limits WHERE reset_at<=?").run(now);
  const row = sql
    .prepare(
      `INSERT INTO rate_limits VALUES (?, 1, ?)
    ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count`,
    )
    .get(key, now + windowMs) as { count: number };
  if (row.count > limit) throw new HttpError(429, "操作过于频繁，请稍后重试");
}
export async function createAccount(
  sql: DatabaseSync,
  input: { username: string; password: string; name: string },
  role: Role = "user",
) {
  ensureRuntimeSchema(sql);
  const passwordHash = await hashPassword(input.password);
  const account = {
    id: randomUUID(),
    username: input.username.toLowerCase(),
    name: input.name,
    role,
  };
  transaction(sql, () => {
    if (
      sql
        .prepare("SELECT 1 FROM accounts WHERE username=?")
        .get(account.username)
    )
      throw new HttpError(409, "该账号已被注册");
    sql
      .prepare("INSERT INTO accounts VALUES (?, ?, ?, ?, ?, ?)")
      .run(
        account.id,
        account.username,
        account.name,
        role,
        passwordHash,
        Date.now(),
      );
    if (role === "admin")
      sql
        .prepare("INSERT INTO staff_access VALUES (?,'owner',1)")
        .run(account.id);
    if (role === "user") {
      const db = readDatabase(sql);
      db.users.push({
        id: account.id,
        username: account.username,
        name: account.name,
      });
      db.favorites[account.id] = [];
      db.revision++;
      writeDatabase(sql, db);
    }
  });
  return { id: account.id, name: account.name, role };
}

/** Upgrade only identifiable pre-staff owners, once; never repair authorization during a request. */
export function migrateLegacyAdminAccess(sql: DatabaseSync) {
  transaction(sql, () => {
    sql.exec(
      "CREATE TABLE IF NOT EXISTS authorization_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
    );
    if (
      sql
        .prepare(
          "SELECT 1 FROM authorization_migrations WHERE name='explicit-staff-access-v1'",
        )
        .get()
    )
      return;
    const missing = sql
      .prepare(
        "SELECT a.id FROM accounts a LEFT JOIN staff_access s ON s.account_id=a.id WHERE a.role='admin' AND s.account_id IS NULL",
      )
      .all();
    // Historical createAccount generated UUID owners. Employee creation has always used staff-* IDs.
    const legacyOwnerId =
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
    for (const account of missing)
      if (legacyOwnerId.test(String(account.id)))
        sql
          .prepare("INSERT INTO staff_access VALUES (?,'owner',1)")
          .run(account.id);
    sql
      .prepare(
        "INSERT INTO authorization_migrations VALUES ('explicit-staff-access-v1',?)",
      )
      .run(new Date().toISOString());
  });
}
