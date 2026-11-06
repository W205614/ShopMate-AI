import express, { type ErrorRequestHandler } from "express";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { tokenHash } from "../src/auth";
import { registerExternalRoutes } from "../src/production/external";
import { enqueueShipment, runLogisticsJobs } from "../src/production/logistics";
import { createPaymentFixture } from "./support/payment-fixture";

let fixture: ReturnType<typeof createPaymentFixture>,
  app: Server,
  provider: Server,
  base: string;
let queryCount = 0,
  subscribeCount = 0;
let queryWait: Promise<void> | undefined,
  queryStarted: (() => void) | undefined;
beforeEach(async () => {
  vi.stubEnv("SHOP_MODE", "demo");
  vi.stubEnv("KUAIDI100_ENABLED", "true");
  vi.stubEnv("KUAIDI100_KEY", "synthetic-key");
  vi.stubEnv("KUAIDI100_CUSTOMER", "synthetic-customer");
  vi.stubEnv("KUAIDI100_CALLBACK_SECRET", "x".repeat(32));
  vi.stubEnv("PUBLIC_URL", "http://localhost:18888");
  fixture = createPaymentFixture();
  fixture.sql
    .prepare(
      "INSERT INTO sessions(token_hash,account_id,expires_at,mfa_verified) VALUES(?,'u1',?,1)",
    )
    .run(tokenHash("logistics-recovery-user"), Date.now() + 60_000);
  queryCount = subscribeCount = 0;
  queryWait = undefined;
  queryStarted = undefined;
  provider = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const data = new URLSearchParams(Buffer.concat(chunks).toString());
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/subscribe") {
      subscribeCount++;
      res.end('{"result":true,"returnCode":"200"}');
      return;
    }
    queryCount++;
    queryStarted?.();
    if (queryWait) await queryWait;
    const param = JSON.parse(data.get("param")!);
    res.end(
      JSON.stringify({
        status: "200",
        com: param.com,
        nu: param.num,
        state: "0",
        data: [{ time: "2026-11-06 12:00:00", context: "已揽收" }],
      }),
    );
  }).listen(0, "127.0.0.1");
  await new Promise<void>((done) => provider.once("listening", done));
  const providerBase = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
  vi.stubEnv("KUAIDI100_QUERY_URL", providerBase + "/query");
  vi.stubEnv("KUAIDI100_SUBSCRIBE_URL", providerBase + "/subscribe");
  const instance = express();
  instance.use(express.json());
  registerExternalRoutes(instance, fixture.sql);
  const errors: ErrorRequestHandler = (error, _req, res, _next) =>
    res.status(error.status ?? 500).json({ code: error.code });
  instance.use(errors);
  app = instance.listen(0, "127.0.0.1");
  await new Promise<void>((done) => app.once("listening", done));
  base = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
});
afterEach(async () => {
  for (const server of [app, provider]) {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
  fixture.sql.close();
  vi.unstubAllEnvs();
});
async function shipment(tracking: string) {
  const orderId = await fixture.order();
  enqueueShipment(fixture.sql, { orderId, carrier: "shunfeng", tracking });
  return {
    orderId,
    id: String(
      fixture.sql
        .prepare("SELECT id FROM external_shipments WHERE order_id=?")
        .get(orderId)!.id,
    ),
  };
}
const refresh = (orderId: string, shipmentId: string) =>
  fetch(`${base}/api/orders/${orderId}/shipment/${shipmentId}/refresh`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: "shopmate_user=logistics-recovery-user",
    },
    body: JSON.stringify({ requestId: "original-shipment-query" }),
  });

it("reserves a query target before network I/O and resumes unfinished results only for the original target", async () => {
  const first = await shipment("SF-FIRST"),
    second = await shipment("SF-SECOND");
  let release!: () => void;
  const requested = new Promise<void>((done) => {
    queryStarted = done;
  });
  queryWait = new Promise<void>((done) => {
    release = done;
  });
  const pending = refresh(first.orderId, first.id);
  await requested;
  try {
    expect((await refresh(second.orderId, second.id)).status).toBe(409);
    expect((await refresh(second.orderId, first.id)).status).toBe(409);
    expect(queryCount).toBe(1);
  } finally {
    release();
  }
  const response = await pending;
  expect(response.status).toBe(200);
  const completed = await response.json();
  expect(await (await refresh(first.orderId, first.id)).json()).toEqual(
    completed,
  );
  expect(queryCount).toBe(1);
  fixture.sql
    .prepare(
      "UPDATE external_logistics_requests SET result='' WHERE actor_id='u1'",
    )
    .run();
  expect((await refresh(first.orderId, first.id)).status).toBe(200);
  expect(queryCount).toBe(2);
});

it("preserves the five-attempt subscription budget across interrupted workers", async () => {
  const remaining = await shipment("SF-FOUR"),
    exhausted = await shipment("SF-FIVE");
  fixture.sql
    .prepare(
      "UPDATE external_shipments SET subscription_status='sending',attempts=4 WHERE id=?",
    )
    .run(remaining.id);
  fixture.sql
    .prepare(
      "UPDATE external_shipments SET subscription_status='sending',attempts=5 WHERE id=?",
    )
    .run(exhausted.id);
  await runLogisticsJobs(fixture.sql);
  expect(subscribeCount).toBe(1);
  expect(
    fixture.sql
      .prepare(
        "SELECT subscription_status,attempts FROM external_shipments WHERE id=?",
      )
      .get(remaining.id),
  ).toMatchObject({ subscription_status: "subscribed", attempts: 5 });
  expect(
    fixture.sql
      .prepare(
        "SELECT subscription_status,attempts,last_error FROM external_shipments WHERE id=?",
      )
      .get(exhausted.id),
  ).toMatchObject({
    subscription_status: "failed",
    attempts: 5,
    last_error: "SUBSCRIPTION_INTERRUPTED",
  });
  await runLogisticsJobs(fixture.sql);
  expect(subscribeCount).toBe(1);
});
