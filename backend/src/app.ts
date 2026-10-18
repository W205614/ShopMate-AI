import express from "express";
import { z } from "zod";
import { marketingApi, publicReviews } from "./marketing";
import type { ErrorRequestHandler } from "express";
import type { DatabaseSync } from "node:sqlite";
import { ZodError } from "zod";
import type { Database, Role, Session } from "../../shared/domain/types";
import { readDatabase, transaction, writeDatabase } from "./database";
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
import { randomUUID, createHash } from "node:crypto";
import { ensureRuntimeSchema, audit } from "./runtime";
import { demand, methodPermission } from "./permissions";
import { operationsApi } from "./operations";
import { registerReadRoutes } from "./read-routes";
import {
  loginSchema,
  methods,
  passwordSchema,
  registerSchema,
  roleSchema,
} from "./validation";

export function visibleDatabase(
  db: Database,
  role: Role,
  sessions: { user: Session | null; admin: Session | null },
): Database {
  const counts = new Map<string, number>();
  for (const claim of db.couponClaims)
    counts.set(claim.couponId, (counts.get(claim.couponId) ?? 0) + 1);
  const projected = {
    ...db,
    coupons: db.coupons.map((coupon) => ({
      ...coupon,
      claimedCount: counts.get(coupon.id) ?? 0,
    })),
  };
  if (role === "admin" && sessions.admin) return projected;
  const uid = sessions.user?.id;
  return {
    ...projected,
    couponClaims: db.couponClaims.filter((c) => c.userId === uid),
    reviews: db.reviews.filter((r) => r.userId === uid),
    checkoutQuotes: db.checkoutQuotes.filter((q) => q.userId === uid),
    orderRequests: [],
    inventoryRequests: [],
    users: db.users.filter((u) => u.id === uid),
    carts: db.carts.filter((c) => c.userId === uid),
    addresses: db.addresses.filter((a) => a.userId === uid),
    orders: db.orders.filter((o) => o.userId === uid),
    afterSales: db.afterSales.filter((a) => a.userId === uid),
    conversations: db.conversations.filter((c) => c.userId === uid),
    favorites: uid ? { [uid]: db.favorites[uid] ?? [] } : {},
    inventory: [],
    ledger: [],
    shippingRules: [],
    suppliers: [],
    purchaseOrders: [],
    returnInspections: [],
    auditEntries: [],
    notifications: (db.notifications ?? []).filter(
      (n) => !!uid && n.userId === uid,
    ),
    pointsEntries: (db.pointsEntries ?? []).filter(
      (n) => !!uid && n.userId === uid,
    ),
    promotions: (db.promotions ?? []).filter((p) => p.active),
    faqs: db.faqs.filter((f) => f.active),
  };
}

export async function createApp(
  sql: DatabaseSync,
  config: {
    origins: string[];
    secureCookies?: boolean;
    sessionTtl?: number;
    trustProxy?: boolean;
    allowDemoReset?: boolean;
    logRequests?: boolean;
    afterSaleDays?: number;
    allowLegacyCommands?: boolean;
  },
) {
  ensureRuntimeSchema(sql);
  if (
    config.afterSaleDays !== undefined &&
    (!Number.isSafeInteger(config.afterSaleDays) ||
      config.afterSaleDays < 1 ||
      config.afterSaleDays > 365)
  )
    throw new Error("AFTER_SALE_DAYS must be an integer between 1 and 365");
  const app = express();
  if (config.trustProxy) app.set("trust proxy", 1);
  let activeRequests = 0;
  app.use((req, res, next) => {
    const incoming = req.get("X-Request-ID");
    const requestId =
      incoming && /^[a-zA-Z0-9_-]{1,128}$/.test(incoming)
        ? incoming
        : randomUUID();
    res.locals.requestId = requestId;
    res.setHeader("X-Request-ID", requestId);
    if (activeRequests >= 64)
      return void res.status(429).json({
        message: "服务繁忙，请稍后重试",
        code: "OVERLOADED",
        requestId,
      });
    activeRequests++;
    const start = performance.now();
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      activeRequests--;
      if (config.logRequests)
        console.log(
          JSON.stringify({
            level: "info",
            event: "http",
            requestId,
            method: req.method,
            path: req.path,
            status: res.statusCode,
            durationMs: Math.round(performance.now() - start),
          }),
        );
    };
    res.once("finish", finish);
    res.once("close", finish);
    next();
  });
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
  app.use((req, res, next) => {
    const largeImage =
      req.path === "/api/actions/saveProduct" ||
      req.path === "/api/actions/saveCategory";
    if (largeImage && !findSession(sql, req, "admin"))
      return next(new HttpError(401, "请先登录管理账号"));
    return express.json({
      limit: largeImage
        ? "8mb"
        : req.path.startsWith("/api/auth/")
          ? "4kb"
          : "128kb",
    })(req, res, next);
  });
  app.get("/api/live", (_req, res) => res.json({ status: "ok" }));
  app.get("/api/health", (_req, res) => {
    if (app.locals.draining)
      return void res.status(503).json({ status: "draining" });
    sql.prepare("SELECT version,revision FROM storage_meta WHERE id=1").get();
    res.json({ status: "ok" });
  });
  app.get("/api/state", (req, res) => {
    const role = roleSchema.parse(req.query.role ?? "user");
    const sessions = {
      user: findSession(sql, req, "user"),
      admin: findSession(sql, req, "admin"),
    };
    if (
      role === "admin" &&
      sessions.admin?.staffRole &&
      sessions.admin.staffRole !== "owner"
    )
      throw new HttpError(403, "员工请使用分领域工作台接口");
    res.setHeader("Deprecation", "true");
    // An anonymous admin visit must never receive management data.
    res.json({
      db: visibleDatabase(readDatabase(sql), role, sessions),
      sessions,
    });
  });
  registerReadRoutes(app, sql);
  app.get("/api/products/:id/reviews", (req, res) => {
    const productId = String(req.params.id);
    const from = `FROM biz_reviews r JOIN order_items i ON i.id=json_extract(r.data,'$.orderItemId') JOIN biz_orders o ON o.key=r.order_id WHERE r.product_id=? AND i.product_id=r.product_id AND o.user_id=r.user_id AND coalesce(json_extract(r.data,'$.hidden'),0)=0 AND coalesce(json_extract(r.data,'$.deleted'),0)=0 AND i.refunded_quantity<i.quantity`;
    const summary = sql
      .prepare(
        `SELECT count(*) AS total,coalesce(round(avg(json_extract(r.data,'$.rating')),1),0) AS averageRating ${from}`,
      )
      .get(productId) as { total: number; averageRating: number };
    const pages = Math.max(1, Math.ceil(summary.total / 10)),
      requested = Number(req.query.page),
      page = Math.min(
        Number.isSafeInteger(requested) && requested > 0 ? requested : 1,
        pages,
      );
    const rows = sql
      .prepare(
        `SELECT r.data ${from} ORDER BY r.created_at DESC,r.key DESC LIMIT 10 OFFSET ?`,
      )
      .all(productId, (page - 1) * 10) as { data: string }[];
    const items = rows.map((row) => {
      const r = JSON.parse(row.data);
      const u = sql
        .prepare("SELECT name FROM accounts WHERE id=?")
        .get(r.userId);
      return {
        id: r.id,
        displayName: `${Array.from(String(u?.name ?? "用户"))[0]}**`,
        rating: r.rating,
        content: r.content,
        createdAt: r.createdAt,
      };
    });
    res.json({ ...summary, page, pages, items });
  });
  app.get("/api/order-requests/:requestId", (req, res) => {
    const session = findSession(sql, req, "user");
    if (!session) throw new HttpError(401, "登录已失效，请重新登录");
    const requestId = z.string().min(1).max(128).parse(req.params.requestId);
    const quoteId = z.string().min(1).max(128).parse(req.query.quoteId);
    const db = readDatabase(sql);
    const binding = db.orderRequests.find(
      (r) => r.userId === session.id && r.requestId === requestId,
    );
    const candidate = binding
      ? binding.quoteId === quoteId
        ? binding.orderId
        : undefined
      : db.checkoutQuotes.find(
          (q) => q.userId === session.id && q.id === quoteId,
        )?.orderId;
    const order = db.orders.find(
      (o) => o.userId === session.id && o.id === candidate,
    );
    res.json({ orderId: order?.id ?? null });
  });
  app.post("/api/auth/profile", (req, res) => {
    const session = findSession(sql, req, "user");
    if (!session) throw new HttpError(401, "登录已失效，请重新登录");
    const { name } = z
      .object({ name: registerSchema.shape.name })
      .strict()
      .parse(req.body);
    transaction(sql, () => {
      sql
        .prepare("UPDATE accounts SET name=? WHERE id=? AND role='user'")
        .run(name, session.id);
      const db = readDatabase(sql);
      const user = db.users.find((u) => u.id === session.id);
      if (!user) throw new HttpError(400, "账号数据不完整");
      user.name = name;
      db.revision++;
      writeDatabase(sql, db);
    });
    res.json({ ...session, name });
  });
  app.post("/api/auth/password", async (req, res) => {
    const session = findSession(sql, req, "user");
    if (!session) throw new HttpError(401, "登录已失效，请重新登录");
    rateLimit(sql, `password:${session.id}`, 5, 15 * 60 * 1000);
    const input = z
      .object({
        currentPassword: z.string().min(1).max(128),
        newPassword: passwordSchema,
      })
      .strict()
      .parse(req.body);
    const account = sql
      .prepare("SELECT * FROM accounts WHERE id=? AND role='user'")
      .get(session.id) as unknown as Account;
    if (!(await checkPassword(input.currentPassword, account.password_hash)))
      throw new HttpError(400, "原密码错误");
    const nextHash = await hashPassword(input.newPassword);
    transaction(sql, () => {
      const current = sql
        .prepare("SELECT password_hash FROM accounts WHERE id=?")
        .get(session.id) as { password_hash: string } | undefined;
      if (
        !findSession(sql, req, "user") ||
        current?.password_hash !== account.password_hash
      )
        throw new HttpError(409, "账号状态已变更，请重新登录后操作");
      sql
        .prepare("UPDATE accounts SET password_hash=? WHERE id=?")
        .run(nextHash, session.id);
      sql.prepare("DELETE FROM sessions WHERE account_id=?").run(session.id);
    });
    clearSession(sql, req, res, "user", secure);
    res.json({ ok: true });
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
    if (account.role === "admin") {
      const access = sql
        .prepare("SELECT active FROM staff_access WHERE account_id=?")
        .get(account.id);
      if (access && !access.active) throw new HttpError(403, "员工账号已停用");
    }
    const latest = sql
      .prepare("SELECT password_hash FROM accounts WHERE id=?")
      .get(account.id);
    if (latest?.password_hash !== account.password_hash)
      throw new HttpError(409, "账号状态已更新，请重新登录");
    sql.prepare("DELETE FROM rate_limits WHERE key=?").run(key);
    issueSession(sql, req, res, account, secure, ttl);
    const access =
      account.role === "admin"
        ? sql
            .prepare("SELECT staff_role FROM staff_access WHERE account_id=?")
            .get(account.id)
        : undefined;
    res.json({
      id: account.id,
      name: account.name,
      role: account.role,
      ...(account.role === "admin"
        ? { staffRole: access?.staff_role ?? "owner" }
        : {}),
    });
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
    ...marketingApi,
    ...operationsApi,
    async resetDemo() {
      admin();
      if (!config.allowDemoReset)
        throw new HttpError(403, "当前部署已关闭网页数据重置，请使用维护流程");
      await transact(() => undefined, true);
    },
  };
  app.post("/api/actions/:method", async (req, res) => {
    const method = String(req.params.method);
    if (!Object.hasOwn(methods, method)) throw new HttpError(404, "接口不存在");
    const definition = methods[method as keyof typeof methods];
    const session = findSession(sql, req, definition.role);
    if (!session) throw new HttpError(401, "登录已失效，请重新登录");
    res.locals.actorId = session.id;
    res.locals.action = method;
    const args = definition.args.parse(req.body?.args);
    if (definition.role === "admin")
      demand(session, methodPermission(method, args));
    const requestId =
      req.body?.requestId === undefined
        ? undefined
        : z.string().min(1).max(128).parse(req.body.requestId);
    res.locals.commandRequestId = requestId;
    res.locals.objectId =
      typeof args[0] === "string"
        ? args[0]
        : (args[0] as { id?: string } | undefined)?.id;
    if (!requestId) {
      if (!config.allowLegacyCommands)
        throw new HttpError(
          400,
          "业务写请求必须携带请求标识",
          "REQUEST_ID_REQUIRED",
        );
      res.setHeader("Deprecation", "true");
    }
    if (requestId) {
      if (["saveProduct", "saveCategory", "saveCoupon"].includes(method)) {
        const input = args[0] as { id?: string; version?: number };
        if (input.id && input.version === undefined)
          throw new HttpError(
            400,
            "编辑已有记录必须提交读取时版本",
            "VERSION_REQUIRED",
          );
      }
      if (
        ["toggleProduct", "toggleCoupon"].includes(method) &&
        (typeof args[1] !== "boolean" || typeof args[2] !== "number")
      )
        throw new HttpError(
          400,
          "请提交目标启用状态和读取时版本",
          "VERSION_REQUIRED",
        );
      if (method === "favorite" && typeof args[1] !== "boolean")
        throw new HttpError(400, "请提交目标收藏状态");
      if (method === "deleteCategory" && typeof args[1] !== "number")
        throw new HttpError(
          400,
          "删除分类必须提交读取时版本",
          "VERSION_REQUIRED",
        );
      if (
        method === "saveAddress" &&
        !(args[0] as { id?: string }).id &&
        !(args[0] as { province?: string }).province
      )
        throw new HttpError(400, "新地址请填写配送省份");
    }
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(args))
      .digest("hex");
    if (requestId) {
      const prior = sql
        .prepare(
          "SELECT fingerprint,result FROM command_results WHERE actor_id=? AND method=? AND request_id=?",
        )
        .get(session.id, method, requestId) as
        { fingerprint: string; result: string } | undefined;
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw new HttpError(
            409,
            "请求标识已用于其他内容",
            "IDEMPOTENCY_CONFLICT",
          );
        return void res.json({ result: JSON.parse(prior.result) });
      }
    }
    // Only the operation's verified role enters domain logic; body IDs/roles grant no authority.
    const result = await context.run(
      {
        sql,
        user: definition.role === "user" ? session : null,
        afterSaleDays: config.afterSaleDays ?? 7,
        admin: definition.role === "admin" ? session : null,
        command: requestId
          ? { method, requestId, fingerprint, args }
          : undefined,
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
  const onError: ErrorRequestHandler = (error, req, res, _next) => {
    const requestId = res.locals.requestId as string;
    const databaseBusy =
      error.code === "ERR_SQLITE_ERROR" && /locked|busy/i.test(error.message);
    if (res.locals.actorId && res.locals.action && !databaseBusy)
      try {
        audit(
          sql,
          res.locals.actorId,
          res.locals.action,
          res.locals.commandRequestId ?? requestId,
          `rejected:${error.status ?? 500}`,
          res.locals.objectId,
        );
      } catch {
        /* Database failure is already captured by the request log. */
      }
    if (error instanceof ZodError)
      return void res.status(400).json({
        message: error.issues[0]?.message ?? "参数无效",
        code: "INVALID_INPUT",
        requestId,
      });
    if (error instanceof HttpError)
      return void res.status(error.status).json({
        message: error.message,
        code: error.code ?? `HTTP_${error.status}`,
        requestId,
      });
    if (error.type === "entity.parse.failed")
      return void res.status(400).json({ message: "请求必须为有效 JSON" });
    if (error.type === "entity.too.large")
      return void res.status(413).json({ message: "请求内容过大" });
    if (databaseBusy) {
      console.error(
        JSON.stringify({
          level: "warn",
          event: "database_busy",
          requestId,
          actorId: res.locals.actorId,
          action: res.locals.action,
          objectId: res.locals.objectId,
        }),
      );
      return void res.status(503).set("Retry-After", "1").json({
        message: "数据正在处理，请稍后使用原请求重试",
        code: "DATABASE_BUSY",
        requestId,
      });
    }
    console.error(
      JSON.stringify({
        level: "error",
        event: "request_failed",
        requestId,
        code: error.code ?? "INTERNAL_ERROR",
        path: req.path,
      }),
    );
    res.status(500).json({
      message: "服务暂时不可用，请稍后重试",
      code: "INTERNAL_ERROR",
      requestId,
    });
  };
  app.use(onError);
  return app;
}
