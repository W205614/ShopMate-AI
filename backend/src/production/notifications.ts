import nodemailer from "nodemailer";
import Dysmsapi, { SendSmsRequest } from "@alicloud/dysmsapi20170525";
import { Config } from "@alicloud/openapi-client";
import { RuntimeOptions } from "@alicloud/tea-util";
import type { DatabaseSync } from "node:sqlite";
import type { Express } from "express";
import { createHash } from "node:crypto";
import { z } from "zod";
import { transaction } from "../database";
import { findSession } from "../auth";
import { demand } from "../permissions";
import { HttpError } from "../errors";
import { audit } from "../runtime";
import { integerSetting } from "../config";
import { seal, unseal } from "./config";

export type ContactChannel = "email" | "phone";
type DeliveryInput = {
  channel: ContactChannel;
  target: string;
  event: string;
  text: string;
  variables: Record<string, string>;
  key: string;
};
type DeliveryRow = {
  id: string;
  payload: string;
  attempts: number;
  status: string;
  retry_version: number;
};

export function ensureNotificationSchema(sql: DatabaseSync) {
  sql.exec(`CREATE TABLE IF NOT EXISTS external_notifications(
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
    order_id TEXT, channel TEXT NOT NULL CHECK(channel IN ('email','phone')),
    event TEXT NOT NULL, payload TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','sending','submitted','unknown','failed')),
    attempts INTEGER NOT NULL DEFAULT 0, run_after INTEGER NOT NULL,
    last_error TEXT, provider_id TEXT, retry_version INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS external_notifications_due ON external_notifications(status,run_after);
    CREATE TABLE IF NOT EXISTS external_delivery_budget(
      day TEXT NOT NULL, channel TEXT NOT NULL, attempts INTEGER NOT NULL,
      PRIMARY KEY(day,channel));
    CREATE TABLE IF NOT EXISTS external_notification_requests(
      actor_id TEXT NOT NULL,request_id TEXT NOT NULL,delivery_id TEXT NOT NULL,
      result TEXT NOT NULL,PRIMARY KEY(actor_id,request_id));`);
  if (
    !sql
      .prepare("PRAGMA table_info(external_notification_requests)")
      .all()
      .some((column) => column.name === "fingerprint")
  )
    sql.exec(
      "ALTER TABLE external_notification_requests ADD COLUMN fingerprint TEXT NOT NULL DEFAULT ''",
    );
}

export function verificationChannels(): ContactChannel[] {
  return [
    ...(process.env.SMTP_HOST ? ["email" as const] : []),
    ...(process.env.SMS_ENABLED === "true" ? ["phone" as const] : []),
  ];
}

function smtpConfig() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_FROM)
    throw new HttpError(503, "邮件渠道尚未配置", "EMAIL_NOT_CONFIGURED");
  if (!!process.env.SMTP_USERNAME !== !!process.env.SMTP_PASSWORD)
    throw new Error(
      "SMTP_USERNAME and SMTP_PASSWORD must be configured together",
    );
  return {
    host: process.env.SMTP_HOST,
    port: integerSetting("SMTP_PORT", 587, 1, 65535),
    secure: process.env.SMTP_SECURE === "true",
    requireTLS:
      process.env.SHOP_MODE === "production" &&
      process.env.SMTP_SECURE !== "true",
    ...(process.env.SMTP_USERNAME
      ? {
          auth: {
            user: process.env.SMTP_USERNAME,
            pass: process.env.SMTP_PASSWORD!,
          },
        }
      : {}),
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 10000,
  };
}

function smsConfig(verification: boolean) {
  const template =
    process.env[
      verification
        ? "ALIYUN_SMS_TEMPLATE_VERIFICATION"
        : "ALIYUN_SMS_TEMPLATE_TRANSACTION"
    ];
  if (
    process.env.SMS_ENABLED !== "true" ||
    !process.env.ALIYUN_ACCESS_KEY_ID ||
    !process.env.ALIYUN_ACCESS_KEY_SECRET ||
    !process.env.ALIYUN_SMS_SIGN_NAME ||
    !template
  )
    throw new HttpError(503, "短信渠道尚未配置", "SMS_NOT_CONFIGURED");
  return { template, signName: process.env.ALIYUN_SMS_SIGN_NAME };
}

export function validateNotificationConfig() {
  if (process.env.SMTP_HOST) smtpConfig();
  if (process.env.SMS_ENABLED === "true") {
    smsConfig(true);
    smsConfig(false);
  }
  integerSetting("SMS_DAILY_LIMIT", 100, 1, 1000000);
  integerSetting("EMAIL_DAILY_LIMIT", 500, 1, 1000000);
}

function takeBudget(sql: DatabaseSync, channel: ContactChannel) {
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const limit =
    channel === "phone"
      ? integerSetting("SMS_DAILY_LIMIT", 100, 1, 1000000)
      : integerSetting("EMAIL_DAILY_LIMIT", 500, 1, 1000000);
  transaction(sql, () => {
    const row = sql
      .prepare(
        "SELECT attempts FROM external_delivery_budget WHERE day=? AND channel=?",
      )
      .get(day, channel);
    if (Number(row?.attempts ?? 0) >= limit)
      throw new HttpError(
        429,
        "今日通知发送额度已用完",
        "DELIVERY_BUDGET_EXHAUSTED",
      );
    sql
      .prepare(
        `INSERT INTO external_delivery_budget VALUES(?,?,1) ON CONFLICT(day,channel) DO UPDATE SET attempts=attempts+1`,
      )
      .run(day, channel);
  });
}

function templateVariables(
  variables: Record<string, string>,
  verification: boolean,
) {
  const raw =
    process.env[
      verification
        ? "SMS_TEMPLATE_VARIABLES_VERIFICATION"
        : "SMS_TEMPLATE_VARIABLES_TRANSACTION"
    ];
  const mapping = z
    .record(z.string(), z.string().min(1))
    .parse(
      raw
        ? JSON.parse(raw)
        : verification
          ? { code: "code" }
          : { orderId: "orderId" },
    );
  return Object.fromEntries(
    Object.entries(mapping).map(([name, source]) => {
      if (!Object.hasOwn(variables, source))
        throw new HttpError(
          503,
          "短信模板参数未配置完整",
          "SMS_TEMPLATE_VARIABLE_MISSING",
        );
      return [name, variables[source]];
    }),
  );
}

async function deliver(sql: DatabaseSync, input: DeliveryInput) {
  // Validate configuration before charging the local attempt budget.
  if (input.channel === "email") smtpConfig();
  else smsConfig(input.event === "verification");
  takeBudget(sql, input.channel);
  if (input.channel === "email") {
    const transport = nodemailer.createTransport(smtpConfig());
    try {
      const result = await transport.sendMail({
        from: process.env.SMTP_FROM,
        to: input.target,
        subject:
          input.event === "verification"
            ? "ShopMate 验证码"
            : "ShopMate 订单通知",
        text: input.text,
        messageId: `<${createHash("sha256").update(input.key).digest("hex")}@shopmate.local>`,
      });
      if (!result.accepted?.length)
        throw new HttpError(502, "邮件服务器未接受通知", "EMAIL_REJECTED");
      return String(result.messageId);
    } finally {
      transport.close();
    }
  }
  const { template, signName } = smsConfig(input.event === "verification");
  const client = new Dysmsapi(
    new Config({
      accessKeyId: process.env.ALIYUN_ACCESS_KEY_ID,
      accessKeySecret: process.env.ALIYUN_ACCESS_KEY_SECRET,
      endpoint:
        process.env.SHOP_MODE === "production"
          ? "dysmsapi.aliyuncs.com"
          : (process.env.ALIYUN_SMS_ENDPOINT ?? "dysmsapi.aliyuncs.com"),
      protocol:
        process.env.SHOP_MODE !== "production" &&
        process.env.ALIYUN_SMS_PROTOCOL === "http"
          ? "http"
          : "https",
    }),
  );
  const response = await client.sendSmsWithOptions(
    new SendSmsRequest({
      phoneNumbers: input.target,
      signName,
      templateCode: template,
      templateParam: JSON.stringify(
        templateVariables(input.variables, input.event === "verification"),
      ),
      outId: input.key,
    }),
    new RuntimeOptions({
      autoretry: false,
      connectTimeout: 10000,
      readTimeout: 10000,
    }),
  );
  const body = response.body;
  if (!body || body.code !== "OK")
    throw new HttpError(502, "短信渠道拒绝本次通知", "SMS_REJECTED");
  return String(body.bizId ?? body.requestId);
}

export async function sendVerification(
  input: {
    channel: ContactChannel;
    target: string;
    code: string;
    challengeId: string;
  },
  sql: DatabaseSync,
) {
  ensureNotificationSchema(sql);
  await deliver(sql, {
    ...input,
    key: input.challengeId,
    event: "verification",
    text: `您的 ShopMate 验证码为 ${input.code}，五分钟内有效。请勿告知他人。`,
    variables: { code: input.code },
  });
}

/** Called inside the commerce transaction; no network or plaintext contact payload is persisted. */
export function enqueueNotification(
  sql: DatabaseSync,
  input: {
    userId: string;
    orderId?: string;
    event: string;
    eventId?: string;
    variables?: Record<string, string>;
    text: string;
  },
) {
  const channels = verificationChannels();
  if (!channels.length) return;
  ensureNotificationSchema(sql);
  const contacts = sql
    .prepare("SELECT channel,target FROM verified_contacts WHERE account_id=?")
    .all(input.userId) as { channel: ContactChannel; target: string }[];
  for (const contact of contacts) {
    if (!channels.includes(contact.channel)) continue;
    if (contact.channel === "phone") smsConfig(false);
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          input.userId,
          input.orderId ?? null,
          input.event,
          contact.channel,
          input.eventId ??
            JSON.stringify([
              input.text,
              Object.entries(input.variables ?? {}).sort(([a], [b]) =>
                a.localeCompare(b),
              ),
            ]),
        ]),
      )
      .digest("hex");
    const at = Date.now();
    const payload = seal(
      JSON.stringify({
        channel: contact.channel,
        target: contact.target,
        event: input.event,
        text: input.text,
        variables: { orderId: input.orderId ?? "", ...input.variables },
        key,
      }),
    );
    sql
      .prepare(
        "INSERT OR IGNORE INTO external_notifications(id,account_id,order_id,channel,event,payload,status,run_after,created_at,updated_at) VALUES(?,?,?,?,?,?,'pending',?,?,?)",
      )
      .run(
        key,
        input.userId,
        input.orderId ?? null,
        contact.channel,
        input.event,
        payload,
        at,
        at,
        at,
      );
  }
}

const notificationWorkers = new WeakSet<DatabaseSync>();
export async function runNotificationJobs(sql: DatabaseSync) {
  if (notificationWorkers.has(sql)) return;
  notificationWorkers.add(sql);
  try {
    // A crash after the remote server accepted data cannot prove delivery failure.
    sql
      .prepare(
        "UPDATE external_notifications SET status='unknown',last_error='DELIVERY_INTERRUPTED',updated_at=? WHERE status='sending'",
      )
      .run(Date.now());
    const rows = sql
      .prepare(
        "SELECT * FROM external_notifications WHERE status='pending' AND run_after<=? ORDER BY run_after,id LIMIT 5",
      )
      .all(Date.now()) as DeliveryRow[];
    for (const row of rows) {
      const claimed = sql
        .prepare(
          "UPDATE external_notifications SET status='sending',attempts=attempts+1,updated_at=? WHERE id=? AND status='pending'",
        )
        .run(Date.now(), row.id);
      if (!claimed.changes) continue;
      try {
        const input = JSON.parse(unseal(row.payload)) as DeliveryInput;
        const account = sql
          .prepare(
            "SELECT 1 FROM verified_contacts WHERE account_id=(SELECT account_id FROM external_notifications WHERE id=?) AND channel=? AND target=?",
          )
          .get(row.id, input.channel, input.target);
        if (!account)
          throw new HttpError(
            409,
            "联系方式已失效",
            "DELIVERY_CONTACT_CHANGED",
          );
        const providerId = await deliver(sql, input);
        sql
          .prepare(
            "UPDATE external_notifications SET status='submitted',provider_id=?,last_error=NULL,updated_at=? WHERE id=? AND status='sending' AND payload<>''",
          )
          .run(providerId, Date.now(), row.id);
      } catch (error) {
        const attempts = row.attempts + 1;
        const known = error instanceof HttpError;
        const retryable = known && error.code === "DELIVERY_BUDGET_EXHAUSTED";
        const status =
          retryable && attempts < 5 ? "pending" : known ? "failed" : "unknown";
        const code = known
          ? (error.code ?? "DELIVERY_REJECTED")
          : "DELIVERY_RESULT_UNKNOWN";
        sql
          .prepare(
            "UPDATE external_notifications SET status=?,run_after=?,last_error=?,updated_at=? WHERE id=? AND status='sending' AND payload<>''",
          )
          .run(
            status,
            Date.now() + Math.min(3600000, 1000 * 2 ** attempts),
            code,
            Date.now(),
            row.id,
          );
      }
    }
  } finally {
    notificationWorkers.delete(sql);
  }
}

export function registerNotificationRoutes(app: Express, sql: DatabaseSync) {
  app.get("/api/admin/notifications", (req, res) => {
    demand(findSession(sql, req, "admin"), "settings");
    const page = z.coerce
      .number()
      .int()
      .positive()
      .max(1000000)
      .parse(req.query.page ?? 1);
    const status = z
      .enum(["pending", "sending", "submitted", "unknown", "failed"])
      .optional()
      .parse(req.query.status);
    const where = status ? "WHERE status=?" : "";
    const args = status ? [status] : [];
    const total = Number(
      sql
        .prepare(`SELECT count(*) n FROM external_notifications ${where}`)
        .get(...args)?.n ?? 0,
    );
    const items = sql
      .prepare(
        `SELECT id,account_id accountId,order_id orderId,channel,event,status,attempts,last_error lastError,retry_version retryVersion,created_at createdAt,updated_at updatedAt FROM external_notifications ${where} ORDER BY created_at DESC,id LIMIT 20 OFFSET ?`,
      )
      .all(...args, (page - 1) * 20);
    res.json({
      items,
      total,
      page,
      pageSize: 20,
      pages: Math.max(1, Math.ceil(total / 20)),
    });
  });
  app.post("/api/admin/notifications/:id/retry", (req, res) => {
    const actor = findSession(sql, req, "admin");
    demand(actor, "settings");
    const id = z.string().min(1).max(128).parse(req.params.id);
    const input = z
      .object({
        requestId: z.string().min(1).max(128),
        retryVersion: z.number().int().nonnegative(),
        confirmPossibleDuplicate: z.boolean().optional(),
      })
      .strict()
      .parse(req.body);
    const result = transaction(sql, () => {
      const fingerprint = createHash("sha256")
        .update(
          JSON.stringify([
            id,
            input.retryVersion,
            !!input.confirmPossibleDuplicate,
          ]),
        )
        .digest("hex");
      const previous = sql
        .prepare(
          "SELECT delivery_id,result,fingerprint FROM external_notification_requests WHERE actor_id=? AND request_id=?",
        )
        .get(actor!.id, input.requestId);
      if (previous) {
        if (previous.delivery_id !== id || previous.fingerprint !== fingerprint)
          throw new HttpError(409, "请求标识已使用", "IDEMPOTENCY_CONFLICT");
        return JSON.parse(String(previous.result));
      }
      const row = sql
        .prepare(
          "SELECT status,retry_version,payload FROM external_notifications WHERE id=?",
        )
        .get(id);
      if (!row)
        throw new HttpError(404, "通知不存在", "NOTIFICATION_NOT_FOUND");
      if (!row.payload)
        throw new HttpError(409, "账号已注销，不能重发通知", "ACCOUNT_CLOSED");
      if (
        !["unknown", "failed"].includes(String(row.status)) ||
        row.retry_version !== input.retryVersion
      )
        throw new HttpError(
          409,
          "通知状态已变化",
          "NOTIFICATION_STATE_CONFLICT",
        );
      if (row.status === "unknown" && !input.confirmPossibleDuplicate)
        throw new HttpError(
          409,
          "渠道结果未知，重发可能重复，请确认后重试",
          "DELIVERY_DUPLICATE_CONFIRMATION_REQUIRED",
        );
      sql
        .prepare(
          "UPDATE external_notifications SET status='pending',attempts=0,run_after=?,last_error=NULL,retry_version=retry_version+1,updated_at=? WHERE id=?",
        )
        .run(Date.now(), Date.now(), id);
      const value = {
        id,
        status: "pending",
        retryVersion: input.retryVersion + 1,
      };
      sql
        .prepare(
          "INSERT INTO external_notification_requests(actor_id,request_id,delivery_id,result,fingerprint) VALUES(?,?,?,?,?)",
        )
        .run(
          actor!.id,
          input.requestId,
          id,
          JSON.stringify(value),
          fingerprint,
        );
      audit(
        sql,
        actor!.id,
        "retryNotification",
        input.requestId,
        "rescheduled",
        id,
      );
      return value;
    });
    res.json(result);
  });
}
