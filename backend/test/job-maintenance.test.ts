import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { openDatabase, queryRecord } from "../src/database";
import { createApp } from "../src/app";
import { tokenHash } from "../src/auth";
import { ensureRuntimeSchema } from "../src/runtime";
import { runDueJobs } from "../src/jobs";

let sql: DatabaseSync, server: Server, base: string;
const cookie = "shopmate_admin=owner";
beforeAll(async () => {
  sql = openDatabase(":memory:");
  const app = await createApp(sql, { origins: ["http://localhost"] });
  for (const [id, role] of [
    ["owner", "admin"],
    ["staff", "admin"],
    ["customer", "user"],
  ]) {
    sql
      .prepare("INSERT INTO accounts VALUES(?,?,?,?,?,?)")
      .run(id!, id!, id!, role!, "unused", 1);
    sql
      .prepare("INSERT INTO sessions VALUES(?,?,?)")
      .run(tokenHash(id!), id!, Date.now() + 3600000);
  }
  sql.exec("INSERT INTO staff_access VALUES('owner','owner',1),('staff','support',1)");
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
beforeEach(() =>
  sql.exec(
    "DELETE FROM job_queue; DELETE FROM command_results; DELETE FROM operation_audit",
  ),
);
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  sql.close();
});
function job(
  id = "recoverable",
  kind = "notification",
  payload = JSON.stringify({ userId: "customer", text: "合成验收通知" }),
) {
  sql
    .prepare(
      "INSERT INTO job_queue(id,kind,payload,status,attempts,run_after,last_error,created_at) VALUES(?,?,?,'failed',5,0,'JOB_EXECUTION_FAILED',?)",
    )
    .run(id, kind, payload, new Date().toISOString());
}
function retry(
  id = "recoverable",
  version = 0,
  requestId: string | undefined = crypto.randomUUID(),
  auth = cookie,
) {
  return fetch(`${base}/api/actions/retryJob`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-ShopMate-Request": "1",
      Cookie: auth,
    },
    body: JSON.stringify({ args: [id, version], requestId }),
  });
}
it("migrates the historical job table without losing its state or payload", () => {
  const legacy = new DatabaseSync(":memory:");
  try {
    legacy.exec(
      "CREATE TABLE job_queue(id TEXT PRIMARY KEY,kind TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,run_after INTEGER NOT NULL,last_error TEXT,created_at TEXT NOT NULL); INSERT INTO job_queue VALUES('old','expiry','{}','failed',5,123,'JOB_EXECUTION_FAILED','date')",
    );
    ensureRuntimeSchema(legacy);
    ensureRuntimeSchema(legacy);
    expect(legacy.prepare("SELECT * FROM job_queue").get()).toMatchObject({
      id: "old",
      payload: "{}",
      status: "failed",
      attempts: 5,
      run_after: 123,
      retry_version: 0,
    });
  } finally {
    legacy.close();
  }
});
it("requires owner permission and a request key before changing a job", async () => {
  job();
  expect((await retry("recoverable", 0, "anon", "")).status).toBe(401);
  expect(
    (await retry("recoverable", 0, "staff", "shopmate_admin=staff")).status,
  ).toBe(403);
  expect(
    (await retry("recoverable", 0, "user", "shopmate_user=customer")).status,
  ).toBe(401);
  const response = await fetch(`${base}/api/actions/retryJob`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-ShopMate-Request": "1",
      Cookie: cookie,
    },
    body: JSON.stringify({ args: ["recoverable", 0] }),
  });
  expect(response.status).toBe(400);
  expect(
    sql.prepare("SELECT status,retry_version FROM job_queue").get(),
  ).toMatchObject({ status: "failed", retry_version: 0 });
});
it("replays a lost result, rejects stale cycles and delivers the original notification only once", async () => {
  job();
  const original = sql.prepare("SELECT payload FROM job_queue").get()!.payload;
  const first = await retry("recoverable", 0, "lost-response");
  expect(first.status).toBe(200);
  const result = await first.json();
  expect(result.result).toEqual({
    id: "recoverable",
    status: "pending",
    retryVersion: 1,
  });
  expect(await (await retry("recoverable", 0, "lost-response")).json()).toEqual(
    result,
  );
  expect((await retry("recoverable", 0)).status).toBe(409);
  expect((await retry("recoverable", 1, "lost-response")).status).toBe(409);
  runDueJobs(sql);
  expect(
    sql
      .prepare("SELECT status,payload FROM job_queue WHERE id='recoverable'")
      .get(),
  ).toMatchObject({ status: "done", payload: original });
  const notification = sql.prepare("SELECT key FROM biz_notifications").all();
  expect(notification).toHaveLength(1);
  expect(
    queryRecord(sql, "notifications", String(notification[0]!.key)),
  ).toMatchObject({ userId: "customer", text: "合成验收通知" });
  // Even a later failed delivery cycle with the same attempts count rejects the old version.
  sql.exec(
    "UPDATE job_queue SET status='failed',attempts=5 WHERE id='recoverable'",
  );
  expect((await retry("recoverable", 0)).status).toBe(409);
  expect((await retry("recoverable", 1)).status).toBe(200);
  runDueJobs(sql);
  expect(sql.prepare("SELECT key FROM biz_notifications").all()).toEqual(
    notification,
  );
  const audit = sql
    .prepare(
      "SELECT result FROM operation_audit WHERE result LIKE '%rescheduled%'",
    )
    .all();
  expect(audit).toHaveLength(2);
  expect(JSON.parse(String(audit[0]!.result))).toMatchObject({
    previousAttempts: 5,
    previousError: "JOB_EXECUTION_FAILED",
  });
  const recovered = await (
    await fetch(
      `${base}/api/requests/lost-response?method=retryJob&role=admin`,
      { headers: { Cookie: cookie } },
    )
  ).json();
  expect(recovered).toMatchObject({ found: true, result: result.result });
});
it("rejects unknown, malformed and mismatched-owner payloads and only requeues supported failures", async () => {
  job("unknown", "unsupported");
  job("broken", "notification", "{");
  job(
    "foreign",
    "notification",
    JSON.stringify({ userId: "missing", text: "synthetic" }),
  );
  job(
    "bad-order",
    "notification",
    JSON.stringify({
      userId: "customer",
      text: "synthetic",
      orderId: "foreign-order",
    }),
  );
  job("bad-expiry", "expiry", '{"unexpected":true}');
  job("extra-expiry", "expiry", "{}");
  for (const id of [
    "unknown",
    "broken",
    "foreign",
    "bad-order",
    "bad-expiry",
    "extra-expiry",
  ]) {
    const response = await retry(id);
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("JOB_NOT_RETRYABLE");
  }
  expect((await retry("absent")).status).toBe(404);
  job("expiry-recurring", "expiry", "{}");
  expect((await retry("expiry-recurring")).status).toBe(200);
  expect((await retry("expiry-recurring", 1)).status).toBe(409);
});
it("rolls back scheduling and the recovery receipt when the audit cannot be saved", async () => {
  job();
  sql.exec(
    "CREATE TRIGGER reject_recovery_audit BEFORE INSERT ON operation_audit WHEN NEW.action='retryJob' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END",
  );
  try {
    expect((await retry()).status).toBe(500);
    expect(
      sql.prepare("SELECT status,attempts,retry_version FROM job_queue").get(),
    ).toMatchObject({ status: "failed", attempts: 5, retry_version: 0 });
    expect(sql.prepare("SELECT count(*) n FROM command_results").get()!.n).toBe(
      0,
    );
  } finally {
    sql.exec("DROP TRIGGER reject_recovery_audit");
  }
});
it("finds old failures beyond the latest 100 jobs with stable filtering and bounded pages", async () => {
  job("old-failure");
  sql.exec(
    "UPDATE job_queue SET created_at='2000-01-01' WHERE id='old-failure'",
  );
  const insert = sql.prepare(
    "INSERT INTO job_queue(id,kind,payload,status,run_after,created_at) VALUES(?,'expiry','{}','done',0,'2026-10-21')",
  );
  for (let n = 0; n < 105; n++) insert.run(`new-${n}`);
  const read = (query: string, auth = cookie) =>
    fetch(`${base}/api/admin/jobs${query}`, { headers: { Cookie: auth } });
  const filtered = await (await read("?status=failed")).json();
  expect(filtered).toMatchObject({ total: 1, page: 1, pageSize: 20, pages: 1 });
  expect(filtered.items[0]).toMatchObject({
    id: "old-failure",
    retryVersion: 0,
  });
  expect(filtered.items[0]).not.toHaveProperty("payload");
  const last = await (await read("?page=999&pageSize=100")).json();
  expect(last).toMatchObject({ total: 106, page: 2, pages: 2 });
  expect(last.items).toHaveLength(6);
  expect((await read("?status=invalid")).status).toBe(400);
  expect((await read("?pageSize=101")).status).toBe(400);
  expect((await read("", "shopmate_admin=staff")).status).toBe(403);
});
