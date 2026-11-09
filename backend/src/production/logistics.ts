import express, { type Express, type Request } from "express";
import type { DatabaseSync } from "node:sqlite";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { findSession, rateLimit } from "../auth";
import { permits, demand } from "../permissions";
import { queryRecord, transaction } from "../database";
import type { Order } from "../../../shared/domain/types";
import { HttpError } from "../errors";
import { audit } from "../runtime";

type Shipment = {
  id: string;
  order_id: string;
  after_sale_id: string | null;
  kind: "outbound" | "return";
  carrier: string;
  tracking: string;
  subscription_status: string;
  attempts: number;
  trace: string;
  last_error: string | null;
  updated_at: number;
  run_after: number;
};
function activeShipment(sql: DatabaseSync, row: Shipment) {
  return !!sql
    .prepare(
      "SELECT 1 FROM biz_orders o JOIN accounts a ON a.id=o.user_id WHERE o.key=? AND a.active=1",
    )
    .get(row.order_id);
}
const traceSchema = z
  .object({
    state: z.string().max(30).optional(),
    status: z.string().max(30).optional(),
    com: z.string().max(40).optional(),
    nu: z.string().max(80).optional(),
    data: z
      .array(
        z
          .object({
            time: z.string().max(80),
            context: z.string().max(2000),
            status: z.string().max(80).optional(),
          })
          .strip(),
      )
      .max(500)
      .default([]),
  })
  .strip();
const carrierCodes: Record<string, string> = {
  顺丰速运: "shunfeng",
  顺丰: "shunfeng",
  中通快递: "zhongtong",
  中通: "zhongtong",
  圆通速递: "yuantong",
  圆通: "yuantong",
  韵达快递: "yunda",
  韵达: "yunda",
  申通快递: "shentong",
  申通: "shentong",
  京东物流: "jd",
  邮政快递包裹: "youzhengguonei",
  中国邮政: "youzhengguonei",
  EMS: "ems",
  德邦快递: "debangkuaidi",
  极兔速递: "jtexpress",
};

export function ensureLogisticsSchema(sql: DatabaseSync) {
  sql.exec(`CREATE TABLE IF NOT EXISTS external_shipments(
    id TEXT PRIMARY KEY,order_id TEXT NOT NULL REFERENCES biz_orders(key),
    after_sale_id TEXT,kind TEXT NOT NULL CHECK(kind IN ('outbound','return')),
    carrier TEXT NOT NULL,tracking TEXT NOT NULL,
    subscription_status TEXT NOT NULL CHECK(subscription_status IN ('pending','sending','subscribed','failed','disabled')),
    attempts INTEGER NOT NULL DEFAULT 0,run_after INTEGER NOT NULL,trace TEXT NOT NULL DEFAULT '{}',
    last_error TEXT,updated_at INTEGER NOT NULL,UNIQUE(order_id,kind,after_sale_id,carrier,tracking));
    CREATE INDEX IF NOT EXISTS external_shipments_due ON external_shipments(subscription_status,run_after);
    CREATE INDEX IF NOT EXISTS external_shipments_order ON external_shipments(order_id,kind);
    CREATE TABLE IF NOT EXISTS external_logistics_callbacks(
      id TEXT PRIMARY KEY,shipment_id TEXT NOT NULL REFERENCES external_shipments(id),received_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS external_logistics_requests(
      actor_id TEXT NOT NULL,request_id TEXT NOT NULL,shipment_id TEXT NOT NULL,
      result TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(actor_id,request_id));`);
  if (
    !sql
      .prepare("PRAGMA table_info(external_logistics_requests)")
      .all()
      .some((column) => column.name === "operation")
  )
    sql.exec(
      "ALTER TABLE external_logistics_requests ADD COLUMN operation TEXT NOT NULL DEFAULT 'refresh'",
    );
}

function config() {
  if (process.env.KUAIDI100_ENABLED !== "true")
    throw new HttpError(503, "物流查询尚未启用", "LOGISTICS_NOT_CONFIGURED");
  const key = process.env.KUAIDI100_KEY,
    customer = process.env.KUAIDI100_CUSTOMER,
    secret = process.env.KUAIDI100_CALLBACK_SECRET,
    publicUrl = process.env.PUBLIC_URL;
  if (!key || !customer || !secret || secret.length < 32 || !publicUrl)
    throw new Error(
      "KUAIDI100_KEY, CUSTOMER, CALLBACK_SECRET (32+ chars), PUBLIC_URL are required",
    );
  const queryUrl =
    process.env.KUAIDI100_QUERY_URL ??
    "https://poll.kuaidi100.com/poll/query.do";
  const subscribeUrl =
    process.env.KUAIDI100_SUBSCRIBE_URL ?? "https://poll.kuaidi100.com/poll";
  for (const address of [publicUrl, queryUrl, subscribeUrl]) {
    const url = new URL(address);
    if (
      url.username ||
      url.password ||
      !["http:", "https:"].includes(url.protocol) ||
      (process.env.SHOP_MODE === "production" && url.protocol !== "https:")
    )
      throw new Error("Logistics endpoints must use HTTPS in production");
  }
  return {
    key,
    customer,
    secret,
    publicUrl: publicUrl.replace(/\/$/, ""),
    queryUrl,
    subscribeUrl,
  };
}

export function validateLogisticsConfig() {
  if (process.env.KUAIDI100_ENABLED === "true") config();
}

function normalizeCarrier(value: string) {
  const code = carrierCodes[value] ?? value;
  if (!/^[a-z0-9]{2,40}$/.test(code))
    throw new HttpError(
      400,
      "请选择快递公司或填写快递100公司编码",
      "LOGISTICS_CARRIER_INVALID",
    );
  return code;
}

export function enqueueShipment(
  sql: DatabaseSync,
  input: {
    orderId: string;
    afterSaleId?: string;
    carrier: string;
    tracking: string;
  },
) {
  ensureLogisticsSchema(sql);
  if (process.env.KUAIDI100_ENABLED !== "true") return;
  const carrier = normalizeCarrier(input.carrier);
  const tracking = z
    .string()
    .trim()
    .min(5)
    .max(80)
    .regex(/^[a-zA-Z0-9-]+$/)
    .parse(input.tracking);
  const kind = input.afterSaleId ? "return" : "outbound";
  const id = createHash("sha256")
    .update(
      JSON.stringify([
        input.orderId,
        input.afterSaleId ?? null,
        carrier,
        tracking,
      ]),
    )
    .digest("hex");
  sql
    .prepare(
      "INSERT OR IGNORE INTO external_shipments(id,order_id,after_sale_id,kind,carrier,tracking,subscription_status,run_after,updated_at) VALUES(?,?,?,?,?,?,'pending',?,?)",
    )
    .run(
      id,
      input.orderId,
      input.afterSaleId ?? null,
      kind,
      carrier,
      tracking,
      Date.now(),
      Date.now(),
    );
}

function saltFor(id: string) {
  return createHmac("sha256", config().secret).update(id).digest("hex");
}
function md5(value: string) {
  return createHash("md5").update(value).digest("hex").toUpperCase();
}

async function post(url: string, params: Record<string, string>) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
    redirect: "error",
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new HttpError(502, "物流服务暂时不可用", "LOGISTICS_UPSTREAM_HTTP");
  }
  if (!response.body)
    throw new HttpError(502, "物流响应为空", "LOGISTICS_RESPONSE_INVALID");
  const reader = response.body.getReader(),
    parts: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 2 * 1024 * 1024)
        throw new HttpError(502, "物流响应过大", "LOGISTICS_RESPONSE_INVALID");
      parts.push(value);
    }
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function applyTrace(sql: DatabaseSync, row: Shipment, value: unknown) {
  if (!activeShipment(sql, row))
    throw new HttpError(410, "账号已注销，物流轨迹不再更新", "ACCOUNT_CLOSED");
  const trace = traceSchema.parse(value);
  if (
    (trace.com && trace.com !== row.carrier) ||
    (trace.nu && trace.nu !== row.tracking)
  )
    throw new HttpError(
      400,
      "物流返回的运单不匹配",
      "LOGISTICS_TRACKING_MISMATCH",
    );
  // A callback may have arrived while the query was waiting on the provider.
  const latest = sql
    .prepare("SELECT trace FROM external_shipments WHERE id=?")
    .get(row.id)!;
  const previous = traceSchema.parse(JSON.parse(String(latest.trace)));
  const events = [
    ...new Map(
      [...previous.data, ...trace.data].map((event) => [
        JSON.stringify([event.time, event.context]),
        event,
      ]),
    ).values(),
  ].sort((a, b) => b.time.localeCompare(a.time));
  if (events.length > 500)
    throw new HttpError(502, "物流轨迹超过容量上限", "LOGISTICS_TRACE_LIMIT");
  const newestIncoming = trace.data[0]?.time ?? "",
    newestPrevious = previous.data[0]?.time ?? "";
  const merged = {
    ...(newestIncoming >= newestPrevious ? trace : previous),
    data: events,
  };
  // A delivery trace is informational. It cannot advance order, inspection or refund states.
  sql
    .prepare(
      "UPDATE external_shipments SET trace=?,last_error=NULL,updated_at=? WHERE id=?",
    )
    .run(JSON.stringify(merged), Date.now(), row.id);
  return merged;
}

export async function queryShipment(sql: DatabaseSync, id: string) {
  const row = sql
    .prepare("SELECT * FROM external_shipments WHERE id=?")
    .get(id) as Shipment | undefined;
  if (!row) throw new HttpError(404, "运单不存在", "SHIPMENT_NOT_FOUND");
  if (!activeShipment(sql, row))
    throw new HttpError(410, "账号已注销，物流轨迹不再查询", "ACCOUNT_CLOSED");
  const cfg = config();
  const order = queryRecord<Order>(sql, "orders", row.order_id);
  const phone = order?.address.phone?.replace(/\D/g, "").slice(-4);
  const param = JSON.stringify({
    com: row.carrier,
    num: row.tracking,
    resultv2: "1",
    ...(phone ? { phone } : {}),
  });
  const value = await post(cfg.queryUrl, {
    customer: cfg.customer,
    sign: md5(param + cfg.key + cfg.customer),
    param,
  });
  if (String(value.status) !== "200")
    throw new HttpError(
      502,
      "物流平台尚未返回有效轨迹",
      "LOGISTICS_QUERY_REJECTED",
    );
  return applyTrace(sql, row, value);
}

const workers = new WeakSet<DatabaseSync>();
export async function runLogisticsJobs(sql: DatabaseSync) {
  if (process.env.KUAIDI100_ENABLED !== "true" || workers.has(sql)) return;
  workers.add(sql);
  try {
    sql
      .prepare(
        "UPDATE external_shipments SET subscription_status=CASE WHEN attempts>=5 THEN 'failed' ELSE 'pending' END,last_error='SUBSCRIPTION_INTERRUPTED' WHERE subscription_status='sending'",
      )
      .run();
    const cfg = config();
    const rows = sql
      .prepare(
        "SELECT * FROM external_shipments WHERE subscription_status='pending' AND run_after<=? ORDER BY run_after,id LIMIT 5",
      )
      .all(Date.now()) as Shipment[];
    for (const row of rows) {
      if (!activeShipment(sql, row)) {
        sql
          .prepare(
            "UPDATE external_shipments SET subscription_status='disabled',trace='{}',last_error='ACCOUNT_CLOSED' WHERE id=?",
          )
          .run(row.id);
        continue;
      }
      const claimed = sql
        .prepare(
          "UPDATE external_shipments SET subscription_status='sending',attempts=attempts+1 WHERE id=? AND subscription_status='pending'",
        )
        .run(row.id);
      if (!claimed.changes) continue;
      try {
        const order = queryRecord<Order>(sql, "orders", row.order_id);
        const param = JSON.stringify({
          company: row.carrier,
          number: row.tracking,
          key: cfg.key,
          parameters: {
            callbackurl: `${cfg.publicUrl}/api/webhooks/kuaidi100/${row.id}`,
            salt: saltFor(row.id),
            resultv2: "1",
            ...(order?.address.phone
              ? { phone: order.address.phone.replace(/\D/g, "").slice(-4) }
              : {}),
          },
        });
        const result = await post(cfg.subscribeUrl, { schema: "json", param });
        if (!["200", "501"].includes(String(result.returnCode)))
          throw new HttpError(
            502,
            "物流订阅被拒绝",
            "LOGISTICS_SUBSCRIBE_REJECTED",
          );
        sql
          .prepare(
            "UPDATE external_shipments SET subscription_status='subscribed',last_error=NULL,updated_at=? WHERE id=? AND subscription_status='sending'",
          )
          .run(Date.now(), row.id);
      } catch (error) {
        const attempts = row.attempts + 1;
        sql
          .prepare(
            "UPDATE external_shipments SET subscription_status=?,run_after=?,last_error=?,updated_at=? WHERE id=? AND subscription_status='sending'",
          )
          .run(
            attempts >= 5 ? "failed" : "pending",
            Date.now() + Math.min(3600000, 1000 * 2 ** attempts),
            error instanceof HttpError
              ? (error.code ?? "LOGISTICS_SUBSCRIBE_REJECTED")
              : "LOGISTICS_SUBSCRIPTION_UNKNOWN",
            Date.now(),
            row.id,
          );
      }
    }
  } finally {
    workers.delete(sql);
  }
}

export function registerLogisticsWebhooks(app: Express, sql: DatabaseSync) {
  app.post(
    "/api/webhooks/kuaidi100/:id",
    express.urlencoded({ extended: false, limit: "128kb", inflate: false }),
    (req, res) => {
      const id = z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(req.params.id);
      const row = sql
        .prepare("SELECT * FROM external_shipments WHERE id=?")
        .get(id) as Shipment | undefined;
      if (!row || process.env.KUAIDI100_ENABLED !== "true")
        throw new HttpError(404, "运单不存在", "SHIPMENT_NOT_FOUND");
      const input = z
        .object({
          param: z.string().min(1).max(120000),
          sign: z.string().regex(/^[A-Fa-f0-9]{32}$/),
        })
        .strip()
        .parse(req.body);
      if (
        !timingSafeEqual(
          Buffer.from(md5(input.param + saltFor(id)), "hex"),
          Buffer.from(input.sign, "hex"),
        )
      )
        throw new HttpError(
          401,
          "物流回调签名无效",
          "WEBHOOK_SIGNATURE_INVALID",
        );
      if (!activeShipment(sql, row))
        return void res.json({
          result: true,
          returnCode: "200",
          message: "成功",
        });
      const value = z
        .object({
          status: z.string().max(30),
          lastResult: traceSchema.optional(),
        })
        .passthrough()
        .parse(JSON.parse(input.param));
      const eventId = createHash("sha256")
        .update(id + input.param)
        .digest("hex");
      transaction(sql, () => {
        if (
          sql
            .prepare("SELECT 1 FROM external_logistics_callbacks WHERE id=?")
            .get(eventId)
        )
          return;
        if (value.lastResult) applyTrace(sql, row, value.lastResult);
        if (value.status === "abort")
          sql
            .prepare(
              "UPDATE external_shipments SET last_error='LOGISTICS_TRACKING_ABORTED',updated_at=? WHERE id=?",
            )
            .run(Date.now(), id);
        sql
          .prepare("INSERT INTO external_logistics_callbacks VALUES(?,?,?)")
          .run(eventId, id, Date.now());
      });
      res.json({ result: true, returnCode: "200", message: "成功" });
    },
  );
}

function orderAccess(sql: DatabaseSync, req: Request, orderId: string) {
  const order = queryRecord<Order>(sql, "orders", orderId);
  const user = findSession(sql, req, "user"),
    admin = findSession(sql, req, "admin");
  if (!user && !admin) throw new HttpError(401, "请先登录", "AUTH_REQUIRED");
  if (
    !order ||
    (order.userId !== user?.id &&
      !permits(admin, "warehouse") &&
      !permits(admin, "support") &&
      !permits(admin, "finance"))
  )
    throw new HttpError(404, "订单不存在", "ORDER_NOT_FOUND");
  return { order, actorId: admin?.id ?? user!.id };
}

export function registerLogisticsRoutes(app: Express, sql: DatabaseSync) {
  app.get("/api/orders/:id/shipment", (req, res) => {
    const id = z.string().min(1).max(100).parse(req.params.id);
    orderAccess(sql, req, id);
    const rows = sql
      .prepare(
        "SELECT * FROM external_shipments WHERE order_id=? ORDER BY updated_at DESC,id",
      )
      .all(id) as Shipment[];
    res.json({
      enabled: process.env.KUAIDI100_ENABLED === "true",
      items: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        afterSaleId: row.after_sale_id,
        carrier: row.carrier,
        tracking: row.tracking,
        status: row.subscription_status,
        lastError: row.last_error,
        updatedAt: row.updated_at,
        trace: JSON.parse(row.trace),
      })),
    });
  });
  app.post("/api/orders/:id/shipment/:shipmentId/refresh", async (req, res) => {
    const id = z.string().min(1).max(100).parse(req.params.id);
    const { actorId } = orderAccess(sql, req, id);
    const shipmentId = z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(req.params.shipmentId);
    const input = z
      .object({ requestId: z.string().min(1).max(128) })
      .strict()
      .parse(req.body);
    const previous = transaction(sql, () => {
      const receipt = sql
        .prepare(
          "SELECT r.shipment_id,r.result,r.operation,s.order_id FROM external_logistics_requests r JOIN external_shipments s ON s.id=r.shipment_id WHERE r.actor_id=? AND r.request_id=?",
        )
        .get(actorId, input.requestId);
      if (receipt) {
        if (
          receipt.shipment_id !== shipmentId ||
          receipt.order_id !== id ||
          receipt.operation !== "refresh"
        )
          throw new HttpError(
            409,
            "请求标识已用于其他运单",
            "IDEMPOTENCY_CONFLICT",
          );
        return String(receipt.result);
      }
      if (
        !sql
          .prepare("SELECT 1 FROM external_shipments WHERE id=? AND order_id=?")
          .get(shipmentId, id)
      )
        throw new HttpError(404, "运单不存在", "SHIPMENT_NOT_FOUND");
      sql
        .prepare(
          "INSERT INTO external_logistics_requests(actor_id,request_id,shipment_id,result,created_at,operation) VALUES(?,?,?,'',?,'refresh')",
        )
        .run(actorId, input.requestId, shipmentId, Date.now());
      return "";
    });
    if (previous) return void res.json(JSON.parse(previous));
    rateLimit(sql, `logistics:${actorId}`, 20, 60 * 60 * 1000);
    const trace = await queryShipment(sql, shipmentId);
    const result = transaction(sql, () => {
      const shipment = sql
        .prepare("SELECT * FROM external_shipments WHERE id=?")
        .get(shipmentId) as Shipment;
      if (!activeShipment(sql, shipment))
        throw new HttpError(
          410,
          "账号已注销，物流轨迹不再查询",
          "ACCOUNT_CLOSED",
        );
      sql
        .prepare(
          "UPDATE external_logistics_requests SET result=? WHERE actor_id=? AND request_id=? AND result=''",
        )
        .run(JSON.stringify({ trace }), actorId, input.requestId);
      return String(
        sql
          .prepare(
            "SELECT result FROM external_logistics_requests WHERE actor_id=? AND request_id=?",
          )
          .get(actorId, input.requestId)!.result,
      );
    });
    res.json(JSON.parse(result));
  });
  app.post("/api/admin/shipments/:id/retry", (req, res) => {
    const actor = findSession(sql, req, "admin");
    demand(actor, "warehouse");
    const id = z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(req.params.id);
    const input = z
      .object({ requestId: z.string().min(1).max(128) })
      .strict()
      .parse(req.body);
    transaction(sql, () => {
      const previous = sql
        .prepare(
          "SELECT shipment_id,operation FROM external_logistics_requests WHERE actor_id=? AND request_id=?",
        )
        .get(actor!.id, input.requestId);
      if (previous) {
        if (previous.shipment_id !== id || previous.operation !== "retry")
          throw new HttpError(409, "请求标识已使用", "IDEMPOTENCY_CONFLICT");
        return;
      }
      const row = sql
        .prepare(
          "SELECT subscription_status FROM external_shipments WHERE id=?",
        )
        .get(id);
      if (!row) throw new HttpError(404, "运单不存在", "SHIPMENT_NOT_FOUND");
      if (row.subscription_status !== "failed")
        throw new HttpError(
          409,
          "只有失败订阅可重试",
          "SHIPMENT_STATE_CONFLICT",
        );
      sql
        .prepare(
          "UPDATE external_shipments SET subscription_status='pending',attempts=0,run_after=?,last_error=NULL WHERE id=?",
        )
        .run(Date.now(), id);
      sql
        .prepare(
          "INSERT INTO external_logistics_requests(actor_id,request_id,shipment_id,result,created_at,operation) VALUES(?,?,?,?,?,'retry')",
        )
        .run(
          actor!.id,
          input.requestId,
          id,
          '{"status":"pending"}',
          Date.now(),
        );
      audit(
        sql,
        actor!.id,
        "retryShipment",
        input.requestId,
        "rescheduled",
        id,
      );
    });
    res.json({ id, status: "pending" });
  });
}
