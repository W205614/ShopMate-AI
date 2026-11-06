import { afterEach, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../src/database";
import { createApp } from "../src/app";
import { tokenHash } from "../src/auth";
import { createRequestObserver } from "../src/diagnostics";
import {
  ensureBackupState,
  recordRemoteBackup,
} from "../src/backup/backup-state";

let server: Server | undefined, sql: DatabaseSync | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  if (server)
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  sql?.close();
  server = undefined;
  sql = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
async function listen(app: express.Express) {
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server!.once("listening", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

it("uses an independent read-only monitor token and exposes backup and queue alerts without credentials", async () => {
  const monitorToken = "isolated-readonly-monitor-token-32-characters";
  vi.stubEnv("SHOP_MODE", "demo");
  vi.stubEnv("MONITOR_TOKEN", monitorToken);
  vi.stubEnv("BACKUP_DIR", "isolated-backup-directory");
  sql = openDatabase(":memory:");
  ensureBackupState(sql);
  const app = await createApp(sql, { origins: ["http://localhost"] });
  sql
    .prepare(
      "UPDATE backup_runtime SET last_success_at=?,last_error_code='BACKUP_WORKER_FAILED' WHERE id=1",
    )
    .run("2026-11-01T00:00:00.000Z");
  recordRemoteBackup(sql, {
    bucket: "private-test-bucket",
    bundleKey: "private-recovery-key",
    snapshotAt: "2026-11-01T00:00:00.000Z",
    sha256: "a".repeat(64),
  });
  sql
    .prepare(
      "INSERT INTO job_queue(id,kind,payload,status,run_after,created_at) VALUES('private-job','notification','PRIVATE_PAYLOAD','pending',?,?)",
    )
    .run(Date.now() - 600000, new Date().toISOString());
  const base = await listen(app);
  const headers = { Authorization: `Bearer ${monitorToken}` };
  expect((await fetch(`${base}/api/internal/metrics`)).status).toBe(401);
  expect(
    (
      await fetch(`${base}/api/internal/metrics`, {
        headers: { Authorization: "Bearer incorrect" },
      })
    ).status,
  ).toBe(401);
  const diagnostics = await fetch(`${base}/api/internal/diagnostics`, {
    headers,
  });
  expect(diagnostics.status).toBe(200);
  const snapshot = await diagnostics.json();
  expect(snapshot.backup).toMatchObject({
    enabled: true,
    lastErrorCode: "BACKUP_WORKER_FAILED",
    lastRemoteSnapshotAt: "2026-11-01T00:00:00.000Z",
  });
  expect(snapshot.jobs.oldestWaitingMs).toBeGreaterThanOrEqual(600000);
  const response = await fetch(`${base}/api/internal/metrics`, { headers });
  expect(response.status).toBe(200);
  const metrics = await response.text();
  expect(metrics).toContain('shopmate_production_state{kind="backupFailed"} 1');
  expect(metrics).toContain(
    'shopmate_production_state{kind="backupLastSuccessTimestamp"} 1793491200',
  );
  expect(metrics).toMatch(
    /shopmate_production_state\{kind="jobsOldestWaitingSeconds"\} 6\d\d/,
  );
  expect(metrics + JSON.stringify(snapshot)).not.toMatch(
    /private-test-bucket|private-recovery-key|PRIVATE_PAYLOAD|isolated-readonly-monitor-token/,
  );
  expect(
    (
      await fetch(`${base}/api/admin/merchant`, {
        method: "POST",
        headers: {
          ...headers,
          "X-ShopMate-Request": "1",
          "Content-Type": "application/json",
        },
        body: "{}",
      })
    ).status,
  ).toBe(401);
});

it("logs an admission rejection with Retry-After without consuming or releasing an active slot", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const app = express(),
    observer = createRequestObserver(true, 1);
  let release: (() => void) | undefined;
  app.use(observer.middleware);
  app.get("/hold", (_req, res) => {
    release = () => res.json({ ok: true });
  });
  const base = await listen(app);
  const first = fetch(`${base}/hold`);
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  const response = await fetch(`${base}/hold?private=not-logged`, {
    headers: { "X-Request-ID": "original-retry-id" },
  });
  expect(response.status).toBe(429);
  expect(response.headers.get("Retry-After")).toBe("1");
  expect(await response.json()).toMatchObject({
    code: "OVERLOADED",
    requestId: "original-retry-id",
  });
  expect(observer.counters).toMatchObject({
    active: 1,
    overloaded: 1,
    completed: 1,
  });
  const rejection = log.mock.calls
    .map(([value]) => JSON.parse(value))
    .find((entry) => entry.status === 429);
  expect(rejection).toMatchObject({
    event: "http",
    path: "/hold",
    requestId: "original-retry-id",
  });
  expect(JSON.stringify(log.mock.calls)).not.toContain("not-logged");
  release!();
  expect((await first).status).toBe(200);
  await vi.waitFor(() =>
    expect(observer.counters).toMatchObject({ active: 0, completed: 2 }),
  );
});

it("restricts diagnostics to settings permission and returns aggregate data without retained content", async () => {
  vi.stubEnv("BACKUP_DIR", "");
  vi.stubEnv("VCS_REF", "test-revision");
  sql = openDatabase(":memory:");
  const app = await createApp(sql, { origins: ["http://localhost"] });
  for (const [id, role] of [
    ["owner", "admin"],
    ["staff", "admin"],
    ["customer", "user"],
  ]) {
    sql
      .prepare(
        "INSERT INTO accounts(id,username,name,role,password_hash,created_at) VALUES(?,?,?,?,?,?)",
      )
      .run(id, id, id, role, "unused", 1);
    sql
      .prepare(
        "INSERT INTO sessions(token_hash,account_id,expires_at) VALUES(?,?,?)",
      )
      .run(tokenHash(id!), id!, Date.now() + 3600000);
  }
  sql
    .prepare(
      "INSERT INTO staff_access VALUES('owner','owner',1),('staff','support',1)",
    )
    .run();
  sql
    .prepare(
      "INSERT INTO command_results VALUES('customer','pay','secret-request','private-fingerprint','\"SECRET_CONTENT\"',?)",
    )
    .run(new Date().toISOString());
  sql
    .prepare(
      "INSERT INTO job_queue(id,kind,payload,status,run_after,created_at) VALUES('secret-job','notification','SECRET_PAYLOAD','failed',?,?)",
    )
    .run(Date.now() - 600000, new Date().toISOString());
  sql
    .prepare(
      "INSERT INTO job_queue(id,kind,payload,status,run_after,created_at) VALUES('pending-job','notification','{}','pending',?,?)",
    )
    .run(Date.now() - 600000, new Date().toISOString());
  const base = await listen(app);
  expect((await fetch(`${base}/api/admin/diagnostics`)).status).toBe(401);
  expect(
    (
      await fetch(`${base}/api/admin/diagnostics`, {
        headers: { Cookie: "shopmate_user=customer" },
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await fetch(`${base}/api/admin/diagnostics`, {
        headers: { Cookie: "shopmate_admin=staff" },
      })
    ).status,
  ).toBe(403);
  const response = await fetch(`${base}/api/admin/diagnostics`, {
    headers: { Cookie: "shopmate_admin=owner" },
  });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.jobs).toMatchObject({ pending: 1, failed: 1 });
  expect(body.jobs.oldestWaitingMs).toBeGreaterThanOrEqual(600000);
  expect(body.storage.collections.commandResults).toMatchObject({
    rows: 1,
    payloadBytes: 16,
    growthRows: null,
  });
  expect(body.version).toMatchObject({ revisionRef: "test-revision" });
  expect(JSON.stringify(body)).not.toMatch(
    /SECRET_|private-fingerprint|secret-request|secret-job/,
  );
  // A cached sample stays explicitly dated instead of implying immediate totals.
  sql
    .prepare(
      "INSERT INTO command_results VALUES('customer','pay','second','fp','null',?)",
    )
    .run(new Date().toISOString());
  const cached = await (
    await fetch(`${base}/api/admin/diagnostics`, {
      headers: { Cookie: "shopmate_admin=owner" },
    })
  ).json();
  expect(cached.storage.sampledAt).toBe(body.storage.sampledAt);
  expect(cached.storage.collections.commandResults.rows).toBe(1);
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 60001);
  const grown = await (
    await fetch(`${base}/api/admin/diagnostics`, {
      headers: { Cookie: "shopmate_admin=owner" },
    })
  ).json();
  expect(grown.storage.collections.commandResults).toMatchObject({
    rows: 2,
    growthRows: 1,
    growthPayloadBytes: 4,
  });
});
