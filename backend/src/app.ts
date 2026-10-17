import express from "express";
import type { ErrorRequestHandler } from "express";
import type { DatabaseSync } from "node:sqlite";
import { ZodError } from "zod";
import type { Database, Role, Session } from "../../shared/domain/types";
import { readDatabase } from "./database";
import {
  Account,
  HttpError,
  checkPassword,
  clearSession,
  createAccount,
  findSession,
  hashPassword,
  issueSession,
  rateLimit,
} from "./auth";
import { context, admin, transact } from "./repository";
import { commerceApi } from "./commerce";
import { catalogApi } from "./catalog";
import { supportApi } from "./support";
import { loginSchema, methods, registerSchema, roleSchema } from "./validation";

export function visibleDatabase(
  db: Database,
  role: Role,
  sessions: { user: Session | null; admin: Session | null },
): Database {
  if (role === "admin" && sessions.admin) return db;
  const uid = sessions.user?.id;
  return {
    ...db,
    users: db.users.filter((u) => u.id === uid),
    carts: db.carts.filter((c) => c.userId === uid),
    addresses: db.addresses.filter((a) => a.userId === uid),
    orders: db.orders.filter((o) => o.userId === uid),
    afterSales: db.afterSales.filter((a) => a.userId === uid),
    conversations: db.conversations.filter((c) => c.userId === uid),
    favorites: uid ? { [uid]: db.favorites[uid] ?? [] } : {},
    inventory: [],
    ledger: [],
    faqs: db.faqs.filter((f) => f.active),
  };
}

export async function createApp(
  sql: DatabaseSync,
  config: { origins: string[]; secureCookies?: boolean; sessionTtl?: number },
) {
  const app = express();
  const secure = config.secureCookies ?? false;
  const ttl = config.sessionTtl ?? 8 * 60 * 60 * 1000;
  const dummyHash = await hashPassword("unusable-dummy-password");
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    if (
      req.method !== "GET" &&
      (req.get("X-ShopMate-Request") !== "1" ||
        (req.headers.origin && !config.origins.includes(req.headers.origin)))
    )
      return next(new HttpError(403, "请求来源无效，请从商城页面操作"));
    next();
  });
  app.use(express.json({ limit: "8mb" }));
  app.get("/api/health", (_req, res) => {
    sql.prepare("SELECT 1").get();
    res.json({ status: "ok" });
  });
  app.get("/api/state", (req, res) => {
    const role = roleSchema.parse(req.query.role ?? "user");
    const sessions = {
      user: findSession(sql, req, "user"),
      admin: findSession(sql, req, "admin"),
    };
    // An anonymous admin visit must never receive management data.
    res.json({
      db: visibleDatabase(readDatabase(sql), role, sessions),
      sessions,
    });
  });
  app.post("/api/auth/register", async (req, res) => {
    rateLimit(sql, `register:${req.ip}`, 10, 60 * 60 * 1000);
    const input = registerSchema.parse(req.body);
    const account = await createAccount(sql, input);
    issueSession(sql, req, res, account, secure, ttl);
    res.status(201).json(account);
  });
  app.post("/api/auth/login", async (req, res) => {
    const input = loginSchema.parse(req.body);
    rateLimit(sql, `login-ip:${req.ip}`, 60, 15 * 60 * 1000);
    const key = `login-account:${input.role}:${input.username}`;
    rateLimit(sql, key, 10, 15 * 60 * 1000);
    const account = sql
      .prepare("SELECT * FROM accounts WHERE username=? AND role=?")
      .get(input.username, input.role) as Account | undefined;
    const valid = await checkPassword(
      input.password,
      account?.password_hash ?? dummyHash,
    );
    if (!account || !valid) throw new HttpError(401, "账号或密码错误");
    sql.prepare("DELETE FROM rate_limits WHERE key=?").run(key);
    issueSession(sql, req, res, account, secure, ttl);
    res.json({ id: account.id, name: account.name, role: account.role });
  });
  app.post("/api/auth/logout", (req, res) => {
    const role = roleSchema.parse(req.body?.role);
    clearSession(sql, req, res, role, secure);
    res.json({ ok: true });
  });
  const operations = {
    ...commerceApi,
    ...catalogApi,
    ...supportApi,
    async resetDemo() {
      admin();
      await transact(() => undefined, true);
    },
  };
  app.post("/api/actions/:method", async (req, res) => {
    const method = String(req.params.method);
    if (!Object.hasOwn(methods, method)) throw new HttpError(404, "接口不存在");
    const definition = methods[method as keyof typeof methods];
    const session = findSession(sql, req, definition.role);
    if (!session) throw new HttpError(401, "登录已失效，请重新登录");
    const args = definition.args.parse(req.body?.args);
    // Only the operation's verified role enters domain logic; body IDs/roles grant no authority.
    const result = await context.run(
      {
        sql,
        user: definition.role === "user" ? session : null,
        admin: definition.role === "admin" ? session : null,
      },
      () =>
        (
          operations[method as keyof typeof operations] as (
            ...args: unknown[]
          ) => Promise<unknown>
        )(...args),
    );
    res.json({ result: result ?? null });
  });
  app.use((_req, _res, next) => next(new HttpError(404, "接口不存在")));
  const onError: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof ZodError)
      return void res
        .status(400)
        .json({ message: error.issues[0]?.message ?? "参数无效" });
    if (error instanceof HttpError)
      return void res.status(error.status).json({ message: error.message });
    if (error.type === "entity.parse.failed")
      return void res.status(400).json({ message: "请求必须为有效 JSON" });
    if (error.type === "entity.too.large")
      return void res.status(413).json({ message: "请求内容过大" });
    console.error(error);
    res.status(500).json({ message: "服务暂时不可用，请稍后重试" });
  };
  app.use(onError);
  return app;
}
