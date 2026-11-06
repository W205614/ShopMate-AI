import { afterEach, beforeEach, expect, it, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdtemp, stat, access } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { openDatabase, readDatabase, writeDatabase } from "../src/database";
import { tokenHash } from "../src/auth";
import {
  ensureExternalSchema,
  registerExternalRoutes,
  registerLogisticsWebhooks,
  anonymizeExternalAccount,
  exportExternalAccountData,
} from "../src/production/external";
import {
  enqueueShipment,
  runLogisticsJobs,
  queryShipment,
} from "../src/production/logistics";
import {
  uploadAsset,
  validateAssetReferences,
  copyAssets,
  readAsset,
  type Asset,
  importLegacyImages,
} from "../src/production/assets";
import {
  enqueueNotification,
  sendVerification,
  runNotificationJobs,
} from "../src/production/notifications";
import { HttpError } from "../src/errors";
import { ensureRuntimeSchema } from "../src/runtime";
import { runAutomaticBackup } from "../src/backup/automatic-backup";
import { restoreLocalBackup } from "../src/production/remote-backup";

const servers: Server[] = [];
let sql: ReturnType<typeof openDatabase>;
let directory: string;
async function listen(server: Server) {
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function app() {
  const instance = express();
  registerLogisticsWebhooks(instance, sql);
  instance.use(express.json({ limit: "3mb" }));
  registerExternalRoutes(instance, sql);
  instance.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(error instanceof HttpError ? error.status : 400).json({
        code: error instanceof HttpError ? error.code : "INVALID_INPUT",
      });
    },
  );
  return listen(createServer(instance));
}
beforeEach(async () => {
  vi.stubEnv("SHOP_MODE", "demo");
  vi.stubEnv("SMTP_HOST", "");
  vi.stubEnv("SMS_ENABLED", "false");
  vi.stubEnv("KUAIDI100_ENABLED", "false");
  vi.stubEnv("BACKUP_S3_ENABLED", "false");
  vi.stubEnv("CONFIRM_RESTORE", "STOPPED_AND_BACKED_UP");
  vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  directory = await mkdtemp(resolve(tmpdir(), "shopmate-external-"));
  vi.stubEnv("ASSET_DIR", directory);
  vi.stubEnv("ASSET_STORAGE", "local");
  sql = openDatabase(":memory:");
  ensureRuntimeSchema(sql);
  ensureExternalSchema(sql);
  sql.exec(`INSERT INTO accounts(id,username,name,role,password_hash,created_at) VALUES('external-admin','externaladmin','管理员','admin','unused',1);
    INSERT INTO accounts(id,username,name,role,password_hash,created_at) VALUES('external-user','externaluser','顾客','user','unused',1);
    INSERT INTO staff_access VALUES('external-admin','owner',1);
    INSERT INTO sessions(token_hash,account_id,expires_at) VALUES('${tokenHash("external-admin")}', 'external-admin', ${Date.now() + 60000});
    INSERT INTO sessions(token_hash,account_id,expires_at) VALUES('${tokenHash("external-user")}', 'external-user', ${Date.now() + 60000});
    CREATE TABLE IF NOT EXISTS verified_contacts(account_id TEXT,channel TEXT,target TEXT,verified_at INTEGER,PRIMARY KEY(account_id,channel));`);
});
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
  sql.close();
  vi.unstubAllEnvs();
});

it("uploads real decoded images, replays the upload key and rejects invalid/unknown references", async () => {
  const base = await app(),
    content = await sharp({
      create: { width: 12, height: 12, channels: 3, background: "#286144" },
    })
      .png()
      .toBuffer();
  const input = {
    contentBase64: content.toString("base64"),
    requestId: randomUUID(),
  };
  const send = (body: unknown) =>
    fetch(base + "/api/assets", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: "shopmate_admin=external-admin",
      },
      body: JSON.stringify(body),
    });
  const first = await send(input);
  expect(first.status).toBe(201);
  const result = await first.json();
  const replay = await send(input);
  expect(await replay.json()).toEqual(result);
  const image = await fetch(base + result.url);
  expect(image.status).toBe(200);
  expect(image.headers.get("Content-Type")).toBe("image/webp");
  expect(
    (await sharp(Buffer.from(await image.arrayBuffer())).metadata()).format,
  ).toBe("webp");
  expect(validateAssetReferences(sql, [result.url])).toBe(result.bytes);
  expect(() =>
    validateAssetReferences(sql, [`/api/assets/${randomUUID()}`]),
  ).toThrow("不存在");
  const invalid = await send({
    contentBase64: Buffer.from("<svg>not accepted</svg>").toString("base64"),
    requestId: randomUUID(),
  });
  expect(invalid.status).toBe(400);
  const conflict = await send({
    ...input,
    contentBase64: (
      await sharp(content).resize(5, 5).png().toBuffer()
    ).toString("base64"),
  });
  expect(conflict.status).toBe(409);
  expect(
    Number(sql.prepare("SELECT count(*) n FROM external_assets").get()?.n),
  ).toBe(1);
  sql
    .prepare("UPDATE external_assets SET bytes=? WHERE id=?")
    .run(2 * 1024 * 1024, result.id);
  expect(() =>
    validateAssetReferences(sql, [result.url, result.url, result.url]),
  ).toThrow("5 MiB");
});

it("copies and verifies immutable assets before switching metadata, retaining source files", async () => {
  const image = await sharp({
    create: { width: 5, height: 5, channels: 3, background: "#102938" },
  })
    .png()
    .toBuffer();
  const item = await uploadAsset(sql, "external-admin", {
    requestId: "copy-image",
    contentBase64: image.toString("base64"),
  });
  const before = sql
    .prepare("SELECT * FROM external_assets WHERE id=?")
    .get(item.id) as Asset;
  const target = resolve(directory, "new-location");
  expect(
    await copyAssets(sql, "local", { localRoot: target, switch: true }),
  ).toEqual({ copied: 1, switched: true });
  const after = sql
    .prepare("SELECT * FROM external_assets WHERE id=?")
    .get(item.id) as Asset;
  expect(after.local_root).toBe(target);
  expect(await readAsset(before)).toEqual(await readAsset(after));
  expect((await stat(resolve(directory, before.object_key))).isFile()).toBe(
    true,
  );
});

it("explicitly imports built-in catalog images without rewriting historical order data", async () => {
  const before = readDatabase(sql),
    orders = structuredClone(before.orders);
  const result = await importLegacyImages(
    sql,
    resolve("../frontend/public/images"),
    "external-admin",
  );
  expect(result.convertedSources).toBeGreaterThan(0);
  const after = readDatabase(sql);
  expect(
    after.products.every((product) =>
      product.images.every((image) => image.startsWith("/api/assets/")),
    ),
  ).toBe(true);
  expect(
    after.categories.every((category) =>
      category.image.startsWith("/api/assets/"),
    ),
  ).toBe(true);
  expect(after.orders).toEqual(orders);
  expect(
    (
      await importLegacyImages(
        sql,
        resolve("../frontend/public/images"),
        "external-admin",
      )
    ).convertedSources,
  ).toBe(0);
});

it("backs up local images in the worker and restores them with the offline database", async () => {
  const path = resolve(directory, "online.sqlite"),
    source = openDatabase(path);
  ensureRuntimeSchema(source);
  ensureExternalSchema(source);
  source
    .prepare(
      "INSERT INTO accounts(id,username,name,role,password_hash,created_at) VALUES('backup-admin','backupadmin','合成管理员','admin','unused',1)",
    )
    .run();
  try {
    const content = await sharp({
      create: { width: 8, height: 8, channels: 3, background: "#305040" },
    })
      .png()
      .toBuffer();
    const asset = await uploadAsset(source, "backup-admin", {
      requestId: "backup-image",
      contentBase64: content.toString("base64"),
    });
    const target = resolve(directory, "daily.sqlite");
    await runAutomaticBackup(path, target);
    const restoredPath = resolve(directory, "restored.sqlite"),
      assetDir = resolve(directory, "restored-images");
    const result = await restoreLocalBackup(target, restoredPath, assetDir);
    expect(result.assetCount).toBe(1);
    const restored = openDatabase(restoredPath);
    try {
      const row = restored
        .prepare("SELECT * FROM external_assets WHERE id=?")
        .get(asset.id) as Asset;
      expect(row.local_root).toBe(assetDir);
      expect((await readAsset(row)).length).toBe(asset.bytes);
    } finally {
      restored.close();
    }
  } finally {
    source.close();
  }
}, 30000);

it("restores an empty asset catalog without requiring an image sidecar", async () => {
  const path = resolve(directory, "empty-assets.sqlite"),
    source = openDatabase(path);
  ensureRuntimeSchema(source);
  ensureExternalSchema(source);
  try {
    const target = resolve(directory, "empty-assets-backup.sqlite");
    await runAutomaticBackup(path, target);
    await expect(access(target + ".assets")).rejects.toMatchObject({
      code: "ENOENT",
    });
    const result = await restoreLocalBackup(
      target,
      resolve(directory, "empty-assets-restored.sqlite"),
      resolve(directory, "empty-assets-restored-images"),
    );
    expect(result.assetCount).toBe(0);
  } finally {
    source.close();
  }
});

it("subscribes real protocol requests and verifies duplicate/out-of-order callbacks without changing order status", async () => {
  const db = readDatabase(sql),
    product = db.products[0],
    sku = product.skus[0];
  db.orders.push({
    id: "external-order",
    userId: "external-user",
    items: [
      {
        id: "external-line",
        productId: product.id,
        skuId: sku.id,
        name: product.name,
        skuName: sku.name,
        image: product.images[0],
        price: sku.price,
        quantity: 1,
        total: sku.price,
        discount: 0,
        refundedQuantity: 0,
      },
    ],
    subtotal: sku.price,
    discount: 0,
    total: sku.price,
    refundedAmount: 0,
    status: "paid",
    address: {
      id: "external-address",
      userId: "external-user",
      name: "合成顾客",
      phone: "13800001234",
      region: "测试省 测试市",
      detail: "测试地址",
      isDefault: true,
    },
    events: [],
    createdAt: new Date().toISOString(),
  });
  writeDatabase(sql, db);
  let subscription: Record<string, unknown> | undefined;
  let queryWait: Promise<void> | undefined,
    queryStarted: (() => void) | undefined;
  const provider = await listen(
    createServer(async (req, res) => {
      const parts = [];
      for await (const bytes of req) parts.push(Buffer.from(bytes));
      const body = new URLSearchParams(Buffer.concat(parts).toString());
      if (req.url === "/subscribe") {
        subscription = JSON.parse(body.get("param")!);
        res.end('{"result":true,"returnCode":"200"}');
      } else {
        queryStarted?.();
        if (queryWait) await queryWait;
        res.end(
          '{"status":"200","com":"shunfeng","nu":"SF123456","state":"0","data":[{"time":"2026-11-06 12:00:00","context":"已揽件"}]}',
        );
      }
    }),
  );
  vi.stubEnv("PUBLIC_URL", "http://localhost:18188");
  vi.stubEnv("KUAIDI100_ENABLED", "true");
  vi.stubEnv("KUAIDI100_KEY", "synthetic-key");
  vi.stubEnv("KUAIDI100_CUSTOMER", "synthetic-customer");
  vi.stubEnv("KUAIDI100_CALLBACK_SECRET", "s".repeat(32));
  vi.stubEnv("KUAIDI100_SUBSCRIBE_URL", provider + "/subscribe");
  vi.stubEnv("KUAIDI100_QUERY_URL", provider + "/query");
  enqueueShipment(sql, {
    orderId: "external-order",
    carrier: "顺丰速运",
    tracking: "SF123456",
  });
  await runLogisticsJobs(sql);
  expect(subscription?.company).toBe("shunfeng");
  const row = sql.prepare("SELECT * FROM external_shipments").get()!;
  expect(row.subscription_status).toBe("subscribed");
  const base = await app();
  const notify = async (
    time: string,
    context: string,
    state: string,
    valid = true,
  ) => {
    const param = JSON.stringify({
      status: "polling",
      lastResult: {
        state,
        com: "shunfeng",
        nu: "SF123456",
        data: [{ time, context }],
      },
    });
    const salt = createHmac("sha256", "s".repeat(32))
      .update(String(row.id))
      .digest("hex");
    const sign = valid
      ? createHash("md5")
          .update(param + salt)
          .digest("hex")
      : "0".repeat(32);
    return fetch(base + `/api/webhooks/kuaidi100/${row.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ param, sign }),
    });
  };
  expect(
    (await notify("2026-11-06 14:00:00", "已签收", "3", false)).status,
  ).toBe(401);
  expect((await notify("2026-11-06 14:00:00", "已签收", "3")).status).toBe(200);
  await notify("2026-11-06 14:00:00", "已签收", "3");
  await notify("2026-11-06 12:00:00", "已揽件", "0");
  const trace = JSON.parse(
    String(sql.prepare("SELECT trace FROM external_shipments").get()!.trace),
  );
  expect(trace.state).toBe("3");
  expect(trace.data).toHaveLength(2);
  expect(
    sql
      .prepare("SELECT status FROM biz_orders WHERE key='external-order'")
      .get()!.status,
  ).toBe("paid");
  expect(
    Number(
      sql.prepare("SELECT count(*) n FROM external_logistics_callbacks").get()!
        .n,
    ),
  ).toBe(2);
  expect(
    (
      await fetch(base + "/api/orders/external-order/shipment", {
        headers: { Cookie: "shopmate_user=external-user" },
      })
    ).status,
  ).toBe(200);
  expect(
    (await fetch(base + "/api/orders/external-order/shipment")).status,
  ).toBe(401);
  const refreshUrl =
    base + `/api/orders/external-order/shipment/${row.id}/refresh`;
  const refresh = () =>
    fetch(refreshUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: "shopmate_admin=external-admin",
      },
      body: JSON.stringify({ requestId: "historical-private-trace" }),
    });
  expect((await refresh()).status).toBe(200);
  expect(
    sql.prepare("SELECT result FROM external_logistics_requests").get()!.result,
  ).toContain("SF123456");
  for (const suffix of ["a", "b"])
    sql
      .prepare(
        "INSERT INTO external_shipments(id,order_id,after_sale_id,kind,carrier,tracking,subscription_status,run_after,updated_at) VALUES(?, 'external-order','external-sale','return','shunfeng',?,'subscribed',0,0)",
      )
      .run(suffix.repeat(64), "private-return-" + suffix);
  let release!: () => void, started!: () => void;
  queryWait = new Promise<void>((done) => (release = done));
  const requested = new Promise<void>((done) => (started = done));
  queryStarted = started;
  const late = queryShipment(sql, String(row.id));
  await requested;
  sql.prepare("UPDATE accounts SET active=0 WHERE id='external-user'").run();
  anonymizeExternalAccount(sql, "external-user");
  release();
  await expect(late).rejects.toMatchObject({ code: "ACCOUNT_CLOSED" });
  expect(
    (await notify("2026-11-06 15:00:00", "不应恢复的个人轨迹", "3")).status,
  ).toBe(200);
  expect(
    sql
      .prepare(
        "SELECT carrier,tracking,trace,subscription_status FROM external_shipments WHERE id=?",
      )
      .get(String(row.id)),
  ).toMatchObject({
    carrier: "",
    tracking: "closed-" + String(row.id),
    trace: "{}",
    subscription_status: "disabled",
  });
  expect(
    sql.prepare("SELECT count(*) n FROM external_logistics_requests").get()!.n,
  ).toBe(0);
  expect((await refresh()).status).toBe(410);
  expect(
    sql
      .prepare(
        "SELECT count(*) n FROM external_shipments WHERE carrier='' AND tracking='closed-'||id AND trace='{}' AND subscription_status='disabled'",
      )
      .get(),
  ).toMatchObject({ n: 3 });
});

it("deduplicates one business event while retaining separate partial-refund events", () => {
  vi.stubEnv("SMTP_HOST", "127.0.0.1");
  vi.stubEnv("SMTP_FROM", "test@example.test");
  sql
    .prepare(
      "INSERT INTO verified_contacts VALUES('external-user','email','user@example.test',?)",
    )
    .run(Date.now());
  const input = {
    userId: "external-user",
    orderId: "same-order",
    event: "refund",
    text: "订单退款成功",
  };
  enqueueNotification(sql, { ...input, eventId: "refund-1" });
  enqueueNotification(sql, { ...input, eventId: "refund-1" });
  enqueueNotification(sql, { ...input, eventId: "refund-2" });
  expect(
    Number(
      sql.prepare("SELECT count(*) n FROM external_notifications").get()?.n,
    ),
  ).toBe(2);
});

it("keeps notification payload erased when an already-sent SDK request completes after closure", async () => {
  let release!: () => void, started!: () => void;
  const pendingResponse = new Promise<void>((done) => (release = done)),
    requested = new Promise<void>((done) => (started = done));
  const provider = await listen(
    createServer(async (_req, res) => {
      started();
      await pendingResponse;
      res.setHeader("Content-Type", "application/json");
      res.end(
        '{"Code":"OK","Message":"OK","RequestId":"late-request","BizId":"late-biz"}',
      );
    }),
  );
  vi.stubEnv("SMS_ENABLED", "true");
  vi.stubEnv("ALIYUN_ACCESS_KEY_ID", "test-id");
  vi.stubEnv("ALIYUN_ACCESS_KEY_SECRET", "test-secret");
  vi.stubEnv("ALIYUN_SMS_SIGN_NAME", "测试商城");
  vi.stubEnv("ALIYUN_SMS_TEMPLATE_TRANSACTION", "SMS_TEST");
  vi.stubEnv("ALIYUN_SMS_ENDPOINT", new URL(provider).host);
  vi.stubEnv("ALIYUN_SMS_PROTOCOL", "http");
  sql
    .prepare(
      "INSERT INTO verified_contacts VALUES('external-user','phone','13800001234',?)",
    )
    .run(Date.now());
  enqueueNotification(sql, {
    userId: "external-user",
    orderId: "closed-order",
    event: "paid",
    eventId: "payment-1",
    text: "已付款",
  });
  const job = runNotificationJobs(sql);
  await requested;
  sql.prepare("UPDATE accounts SET active=0 WHERE id='external-user'").run();
  anonymizeExternalAccount(sql, "external-user");
  release();
  await job;
  expect(
    sql
      .prepare("SELECT payload,status,last_error FROM external_notifications")
      .get(),
  ).toMatchObject({
    payload: "",
    status: "failed",
    last_error: "ACCOUNT_CLOSED",
  });
});

it("calls the Aliyun SDK through its real HTTP protocol and persists the global send budget", async () => {
  const requests: Record<string, string>[] = [];
  const provider = await listen(
    createServer(async (req, res) => {
      const parts = [];
      for await (const bytes of req) parts.push(Buffer.from(bytes));
      const parameters = new URLSearchParams(Buffer.concat(parts).toString());
      for (const [name, value] of new URL(req.url!, "http://localhost")
        .searchParams)
        parameters.set(name, value);
      requests.push(Object.fromEntries(parameters));
      res.setHeader("Content-Type", "application/json");
      res.end(
        '{"Code":"OK","Message":"OK","RequestId":"synthetic-request","BizId":"synthetic-biz"}',
      );
    }),
  );
  vi.stubEnv("SMS_ENABLED", "true");
  vi.stubEnv("ALIYUN_ACCESS_KEY_ID", "test-id");
  vi.stubEnv("ALIYUN_ACCESS_KEY_SECRET", "test-secret");
  vi.stubEnv("ALIYUN_SMS_SIGN_NAME", "测试商城");
  vi.stubEnv("ALIYUN_SMS_TEMPLATE_VERIFICATION", "SMS_TEST");
  vi.stubEnv("ALIYUN_SMS_ENDPOINT", new URL(provider).host);
  vi.stubEnv("ALIYUN_SMS_PROTOCOL", "http");
  vi.stubEnv("SMS_DAILY_LIMIT", "1");
  await sendVerification(
    {
      channel: "phone",
      target: "13800001234",
      code: "123456",
      challengeId: "challenge1",
    },
    sql,
  );
  expect(requests).toHaveLength(1);
  expect(JSON.parse(requests[0].TemplateParam)).toEqual({ code: "123456" });
  expect(requests[0].PhoneNumbers).toBe("13800001234");
  await expect(
    sendVerification(
      {
        channel: "phone",
        target: "13800001234",
        code: "654321",
        challengeId: "challenge2",
      },
      sql,
    ),
  ).rejects.toMatchObject({ code: "DELIVERY_BUDGET_EXHAUSTED" });
  expect(requests).toHaveLength(1);
});

it("records interrupted external notification submission as unknown and never blindly replays it", async () => {
  vi.stubEnv("SMTP_HOST", "127.0.0.1");
  vi.stubEnv("SMTP_FROM", "test@example.test");
  sql
    .prepare(
      "INSERT INTO verified_contacts VALUES('external-user','email','user@example.test',?)",
    )
    .run(Date.now());
  enqueueNotification(sql, {
    userId: "external-user",
    orderId: "o-test",
    event: "paid",
    text: "订单已付款",
  });
  const row = sql.prepare("SELECT * FROM external_notifications").get()!;
  expect(String(row.payload)).not.toContain("user@example.test");
  expect(String(row.payload)).not.toContain("订单已付款");
  enqueueNotification(sql, {
    userId: "external-user",
    orderId: "o-test",
    event: "paid",
    text: "订单已付款",
  });
  expect(
    Number(
      sql.prepare("SELECT count(*) n FROM external_notifications").get()?.n,
    ),
  ).toBe(1);
  sql.prepare("UPDATE external_notifications SET status='sending'").run();
  await runNotificationJobs(sql);
  expect(
    sql.prepare("SELECT status,attempts FROM external_notifications").get(),
  ).toMatchObject({ status: "unknown", attempts: 0 });
  await runNotificationJobs(sql);
  expect(
    sql.prepare("SELECT status,attempts FROM external_notifications").get(),
  ).toMatchObject({ status: "unknown", attempts: 0 });
  const base = await app();
  const retry = (body: unknown) =>
    fetch(base + `/api/admin/notifications/${row.id}/retry`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: "shopmate_admin=external-admin",
      },
      body: JSON.stringify(body),
    });
  expect(
    (await retry({ requestId: "retry-notification", retryVersion: 0 })).status,
  ).toBe(409);
  const input = {
    requestId: "retry-notification",
    retryVersion: 0,
    confirmPossibleDuplicate: true,
  };
  const first = await retry(input);
  expect(first.status).toBe(200);
  expect(await (await retry(input)).json()).toEqual(await first.json());
  expect((await retry({ ...input, retryVersion: 1 })).status).toBe(409);
  expect(
    JSON.stringify(exportExternalAccountData(sql, "external-user")),
  ).not.toContain("user@example.test");
  anonymizeExternalAccount(sql, "external-user");
  expect(
    sql.prepare("SELECT payload FROM external_notifications").get()?.payload,
  ).toBe("");
  expect(
    (
      await retry({
        requestId: "after-close",
        retryVersion: 1,
        confirmPossibleDuplicate: true,
      })
    ).status,
  ).toBe(409);
});
