import {
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Request, Response } from "express";
import type { Role, Session } from "../../frontend/src/domain/types";
import { readDatabase, transaction, writeDatabase } from "./database";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export type Account = Session & { username: string; password_hash: string };
const options = { N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 };
const digest = (password: string, salt: string) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(password, salt, 64, options, (error, key) =>
      error ? reject(error) : resolve(key),
    ),
  );
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `scrypt$${salt}$${(await digest(password, salt)).toString("hex")}`;
}
export async function checkPassword(password: string, encoded: string) {
  const [, salt, hash] = encoded.split("$");
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
  return row ? (row as unknown as Session) : null;
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
