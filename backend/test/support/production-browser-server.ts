import express from "express";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createServer } from "node:https";
import { resolve } from "node:path";
import type { IncomingHttpHeaders } from "node:http";
import { z } from "zod";
import { createApp } from "../../src/app";
import { createAccount } from "../../src/auth";
import { openDatabase, readDatabase, writeDatabase } from "../../src/database";
import { ensureRuntimeSchema } from "../../src/runtime";
import {
  ensureAccountSchema,
  readMerchant,
} from "../../src/production/accounts";
import { PaymentService } from "../../src/production/payments";
import {
  GatewayError,
  type BillEntry,
  type GatewayEvent,
  type PaymentGateway,
  type PaymentResult,
  type RefundResult,
} from "../../src/production/payment-providers";
import { createSeed } from "../../../shared/domain/seed";
import type {
  Payment,
  PaymentProvider,
  Refund,
} from "../../../shared/domain/production";

if (process.env.PRODUCTION_BROWSER_ACCEPTANCE !== "1")
  throw new Error(
    "This test-only fixture requires PRODUCTION_BROWSER_ACCEPTANCE=1",
  );
const port = Number(process.env.PRODUCTION_BROWSER_PORT ?? "18763");
if (
  !Number.isSafeInteger(port) ||
  port < 1024 ||
  port > 65535 ||
  port === 18086
)
  throw new Error("An isolated non-daily test port is required");
const controlToken = process.env.PRODUCTION_BROWSER_TOKEN;
if (!controlToken || controlToken.length < 32)
  throw new Error(
    "A fixture control token of at least 32 characters is required",
  );
const origin = `https://127.0.0.1:${port}`;
const frontend = resolve("../frontend/dist");
if (!existsSync(resolve(frontend, "index.html")))
  throw new Error("Build frontend/dist before starting this test-only server");
Object.assign(process.env, {
  SHOP_MODE: "production",
  PUBLIC_URL: origin,
  ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  MONITOR_TOKEN: randomBytes(32).toString("hex"),
  PAYMENT_CHANNELS: "wechat_native,wechat_h5,alipay_page,alipay_wap",
  COOKIE_SECURE: "true",
  SMTP_HOST: "127.0.0.1",
  SMTP_FROM: "browser-acceptance@example.test",
  SMS_ENABLED: "false",
  AI_ENABLED: "false",
  ALLOW_DEMO_RESET: "false",
  ALLOW_LEGACY_COMMANDS: "false",
  LOG_REQUESTS: "false",
  BACKUP_DIR: "",
  BACKUP_REPLICA_DIR: "",
  KUAIDI100_ENABLED: "false",
  ASSET_STORAGE: "local",
  ASSET_DIR: resolve(".e2e/production-browser-local/assets"),
});
// The fixture owns only this memory database. It never opens a deployed file or starts real provider workers.
const sql = openDatabase(":memory:");
ensureRuntimeSchema(sql);
ensureAccountSchema(sql);
const seed = createSeed(),
  db = readDatabase(sql);
db.products = seed.products;
db.categories = seed.categories;
db.inventory = db.products.flatMap((product) =>
  product.skus.map((sku) => ({
    id: `browser-opening-${sku.id}`,
    productId: product.id,
    skuId: sku.id,
    delta: sku.stock,
    reason: "隔离验收期初库存",
    createdAt: new Date().toISOString(),
  })),
);
db.shippingRules = seed.shippingRules;
db.promotions = [];
db.faqs = seed.faqs;
db.revision++;
writeDatabase(sql, db);
sql.prepare("UPDATE merchant_profile SET data=? WHERE id=1").run(
  JSON.stringify({
    ...readMerchant(sql),
    legalName: "浏览器验收商家",
    serviceEmail: "support@example.test",
    returnAddress: "仅用于隔离验收的退货地址",
    privacy: {
      version: "privacy-test-1",
      title: "隐私政策",
      text: "本环境仅使用合成账号与测试资料。",
    },
    terms: {
      version: "terms-test-1",
      title: "服务协议",
      text: "本环境不产生真实资金与真实物流。",
    },
  }),
);
await createAccount(
  sql,
  { username: "browser_owner", name: "验收店主", password: "BrowserOwner123!" },
  "admin",
);

class BrowserGateway implements PaymentGateway {
  readonly merchantId: string;
  payments = new Map<string, PaymentResult>();
  refunds = new Map<string, RefundResult>();
  calls = new Map<string, number>();
  bills = new Map<string, BillEntry[]>();
  constructor(readonly provider: PaymentProvider) {
    this.merchantId = `browser-${provider}`;
  }
  count(method: string, id: string) {
    const key = `${method}:${id}`;
    this.calls.set(key, (this.calls.get(key) ?? 0) + 1);
  }
  async create(payment: Payment) {
    this.count("create", payment.id);
    if (!this.payments.has(payment.id))
      this.payments.set(payment.id, {
        merchantOrderNo: payment.id,
        merchantId: this.merchantId,
        amount: payment.amount,
        currency: "CNY",
        status: "pending",
      });
    return payment.channel === "wechat_native"
      ? {
          kind: "qr" as const,
          value: `weixin://browser-acceptance/${payment.id}`,
        }
      : {
          kind: "redirect" as const,
          value: `${origin}/__acceptance/checkout/${payment.id}${payment.channel === "wechat_h5" ? `?revision=${this.calls.get(`create:${payment.id}`)}` : ""}`,
          ...(payment.channel === "wechat_h5"
            ? { expiresAt: new Date(Date.now() + 300_000).toISOString() }
            : {}),
        };
  }
  async query(payment: Payment) {
    this.count("query", payment.id);
    return this.payments.get(payment.id) ?? null;
  }
  async close(payment: Payment) {
    this.count("close", payment.id);
    const current = this.payments.get(payment.id);
    if (current && current.status !== "succeeded") current.status = "closed";
  }
  async refund(refund: Refund, payment: Payment) {
    this.count("refund", refund.id);
    const result: RefundResult = {
      merchantRefundNo: refund.id,
      merchantOrderNo: payment.id,
      amount: refund.amount,
      status: "processing",
      providerRefundId: `browser-refund-${refund.id}`,
    };
    this.refunds.set(refund.id, result);
    return result;
  }
  async queryRefund(refund: Refund) {
    this.count("queryRefund", refund.id);
    return this.refunds.get(refund.id) ?? null;
  }
  webhook(raw: Buffer, headers: IncomingHttpHeaders): GatewayEvent {
    if (headers["x-acceptance-token"] !== controlToken)
      throw new GatewayError("TEST_SIGNATURE_INVALID");
    return JSON.parse(raw.toString("utf8")) as GatewayEvent;
  }
  async bill(date: string) {
    this.count("bill", date);
    return this.bills.get(date) ?? [];
  }
}
const gateways = {
  wechatpay: new BrowserGateway("wechatpay"),
  alipay: new BrowserGateway("alipay"),
};
const inbox: {
  channel: "email" | "phone";
  target: string;
  code: string;
  challengeId: string;
}[] = [];
const api = await createApp(sql, {
  origins: [origin],
  secureCookies: true,
  payments: {
    mode: "production",
    channels: ["wechat_native", "wechat_h5", "alipay_page", "alipay_wap"],
    gateways,
  },
  verificationSender: async (input) => {
    inbox.push(input);
  },
});
const payments = api.locals.payments as PaymentService;
const host = express();
const controls = express.Router();
controls.use((req, res, next) => {
  const actual = req.get("X-Acceptance-Token") ?? "";
  if (
    actual.length !== controlToken.length ||
    !timingSafeEqual(Buffer.from(actual), Buffer.from(controlToken))
  )
    return void res.sendStatus(403);
  next();
});
controls.use(express.json({ limit: "32kb" }));
controls.get("/inbox", (req, res) =>
  res.json(inbox.filter((item) => item.target === req.query.target)),
);
controls.get("/admin-session", (_req, res) => {
  const owner = sql
    .prepare(
      "SELECT id FROM accounts WHERE username='browser_owner' AND role='admin'",
    )
    .get()!;
  const token = randomBytes(32).toString("hex");
  sql
    .prepare(
      "INSERT INTO sessions(token_hash,account_id,expires_at,mfa_verified) VALUES(?,?,?,1)",
    )
    .run(
      createHash("sha256").update(token).digest("hex"),
      owner.id,
      Date.now() + 5 * 60_000,
    );
  res.cookie("shopmate_admin", token, {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
    maxAge: 5 * 60_000,
  });
  res.json({ ok: true });
});
controls.post("/verification/advance-cooldown", (req, res) => {
  const target = z.string().max(254).parse(req.body.target);
  sql
    .prepare(
      "UPDATE verification_challenges SET created_at=created_at-61000 WHERE target=?",
    )
    .run(target);
  res.json({ ok: true });
});
controls.get("/payments", (_req, res) =>
  res.json({
    items: sql
      .prepare("SELECT data FROM production_payments ORDER BY rowid")
      .all()
      .map((row) => JSON.parse(String(row.data))),
    calls: Object.fromEntries(
      Object.entries(gateways).map(([provider, gateway]) => [
        provider,
        Object.fromEntries(gateway.calls),
      ]),
    ),
  }),
);
controls.post("/orders/:id/legacy-copy", (req, res) => {
  const database = readDatabase(sql);
  const source = database.orders.find(
    (order) => order.id === req.params.id && order.status === "pending",
  );
  if (!source) return void res.sendStatus(404);
  const historical = structuredClone(source);
  historical.id = `LEGACY-${randomBytes(12).toString("hex")}`;
  historical.transactionMode = "demo";
  historical.createdAt = "2020-01-01T00:00:00.000Z";
  historical.expiresAt = "2099-01-01T00:00:00.000Z";
  historical.items.forEach((item, index) => {
    item.id = `${historical.id}-line-${index + 1}`;
  });
  historical.events = [
    { at: historical.createdAt, actor: "system", action: "created" },
  ];
  delete historical.quoteId;
  delete historical.inventoryPolicy;
  database.orders.push(historical);
  database.revision++;
  writeDatabase(sql, database);
  res.status(201).json({ id: historical.id });
});
controls.post("/payments/:id/state", async (req, res) => {
  const status = z
    .enum(["pending", "succeeded", "closed", "failed"])
    .parse(req.body.status);
  const gateway = Object.values(gateways).find((candidate) =>
    candidate.payments.has(String(req.params.id)),
  );
  if (!gateway) return void res.sendStatus(404);
  const result = gateway.payments.get(String(req.params.id))!;
  result.status = status;
  if (status === "succeeded") {
    result.providerTransactionId = `browser-transaction-${req.params.id}`;
    result.succeededAt = z.iso
      .datetime({ offset: true })
      .parse(req.body.succeededAt ?? new Date().toISOString());
  }
  await payments.refresh(String(req.params.id));
  res.json({ ok: true });
});
controls.post("/payments/:id/expire-checkout", (req, res) => {
  const changed = sql
    .prepare(
      "UPDATE production_payments SET data=json_set(data,'$.checkout.expiresAt',?) WHERE id=? AND json_extract(data,'$.channel')='wechat_h5' AND json_type(data,'$.checkout')='object'",
    )
    .run(new Date(Date.now() - 60_000).toISOString(), String(req.params.id));
  res.sendStatus(changed.changes === 1 ? 200 : 404);
});
controls.post("/refunds/:id/state", async (req, res) => {
  const status = z
    .enum(["processing", "succeeded", "failed", "abnormal"])
    .parse(req.body.status);
  const gateway = Object.values(gateways).find((candidate) =>
    candidate.refunds.has(String(req.params.id)),
  );
  if (!gateway) return void res.sendStatus(404);
  gateway.refunds.get(String(req.params.id))!.status = status;
  if (status === "succeeded")
    gateway.refunds.get(String(req.params.id))!.succeededAt = z.iso
      .datetime({ offset: true })
      .parse(req.body.succeededAt ?? new Date().toISOString());
  await payments.refreshRefund(String(req.params.id));
  res.json({ ok: true });
});
controls.post("/tick", async (_req, res) => {
  await payments.runDue();
  res.json({ ok: true });
});
controls.post("/bills", (req, res) => {
  const input = z
    .object({
      provider: z.enum(["wechatpay", "alipay"]),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      rows: z
        .array(
          z
            .object({
              kind: z.enum(["payment", "refund"]),
              merchantOrderNo: z.string().min(1),
              merchantRefundNo: z.string().optional(),
              amount: z.number().int().nonnegative(),
              fee: z.number().int().nonnegative(),
            })
            .strict(),
        )
        .max(100),
    })
    .strict()
    .parse(req.body);
  gateways[input.provider].bills.set(input.date, input.rows);
  res.json({ ok: true });
});
controls.get("/reconciliation", (_req, res) => {
  res.json({
    reports: sql
      .prepare("SELECT * FROM production_reconciliation ORDER BY created_at,id")
      .all(),
    billCalls: Object.fromEntries(
      Object.entries(gateways).map(([provider, gateway]) => [
        provider,
        Object.fromEntries(gateway.calls),
      ]),
    ),
  });
});
host.use("/__acceptance/control", controls);
host.get("/__acceptance/checkout/:id", (req, res) =>
  res.type("html").send(
    `<html lang="zh-CN"><meta charset="utf-8"><title>隔离支付验收</title><h1>隔离支付验收收银台</h1><p>此页面不连接真实支付平台，不会扣款。</p><p>测试支付单：${z
      .string()
      .regex(/^SMp[a-f0-9]{28}$/)
      .parse(req.params.id)}</p><a href="/orders">返回商城订单</a></html>`,
  ),
);
host.use((req, res, next) =>
  req.path.startsWith("/api/") ? api(req, res, next) : next(),
);
host.use(express.static(frontend));
host.get("/{*path}", (_req, res) =>
  res.sendFile(resolve(frontend, "index.html")),
);
const certDirectory = resolve(".e2e/production-browser-local");
mkdirSync(certDirectory, { recursive: true });
const keyPath = resolve(certDirectory, "key.pem"),
  certPath = resolve(certDirectory, "cert.pem");
const opensslConfig = resolve(certDirectory, "openssl.cnf");
writeFileSync(
  opensslConfig,
  "[req]\ndistinguished_name=dn\n[dn]\nCN=localhost\n",
);
execFileSync(
  "openssl",
  [
    "req",
    "-config",
    opensslConfig,
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=IP:127.0.0.1,DNS:localhost",
  ],
  { stdio: "ignore", windowsHide: true },
);
const server = createServer(
  { key: readFileSync(keyPath), cert: readFileSync(certPath) },
  host,
).listen(port, "127.0.0.1", () =>
  console.log(`Isolated production browser fixture ready at ${origin}`),
);
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    server.closeAllConnections();
    server.close(() => {
      sql.close();
      process.exit(0);
    });
  });
