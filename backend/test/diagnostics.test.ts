import { afterEach, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../src/database";
import { createApp } from "../src/app";
import { tokenHash } from "../src/auth";
import { createRequestObserver } from "../src/diagnostics";

let server: Server | undefined, sql: DatabaseSync | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  sql?.close(); server = undefined; sql = undefined;
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});
async function listen(app: express.Express) {
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server!.once("listening", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

it("logs an admission rejection with Retry-After without consuming or releasing an active slot", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const app = express(), observer = createRequestObserver(true, 1);
  let release: (() => void) | undefined;
  app.use(observer.middleware);
  app.get("/hold", (_req, res) => { release = () => res.json({ ok: true }); });
  const base = await listen(app);
  const first = fetch(`${base}/hold`);
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  const response = await fetch(`${base}/hold?private=not-logged`, { headers: { "X-Request-ID": "original-retry-id" } });
  expect(response.status).toBe(429);
  expect(response.headers.get("Retry-After")).toBe("1");
  expect(await response.json()).toMatchObject({ code: "OVERLOADED", requestId: "original-retry-id" });
  expect(observer.counters).toMatchObject({ active: 1, overloaded: 1, completed: 1 });
  const rejection = log.mock.calls.map(([value]) => JSON.parse(value)).find(entry => entry.status === 429);
  expect(rejection).toMatchObject({ event: "http", path: "/hold", requestId: "original-retry-id" });
  expect(JSON.stringify(log.mock.calls)).not.toContain("not-logged");
  release!(); expect((await first).status).toBe(200);
  await vi.waitFor(() => expect(observer.counters).toMatchObject({ active: 0, completed: 2 }));
});

it("restricts diagnostics to settings permission and returns aggregate data without retained content", async () => {
  vi.stubEnv("BACKUP_DIR", "");
  vi.stubEnv("VCS_REF", "test-revision");
  sql = openDatabase(":memory:");
  const app = await createApp(sql, { origins: ["http://localhost"] });
  for (const [id, role] of [["owner", "admin"], ["staff", "admin"], ["customer", "user"]]) {
    sql.prepare("INSERT INTO accounts VALUES(?,?,?,?,?,?)").run(id, id, id, role, "unused", 1);
    sql.prepare("INSERT INTO sessions VALUES(?,?,?)").run(tokenHash(id!), id!, Date.now() + 3600000);
  }
  sql.prepare("INSERT INTO staff_access VALUES('staff','support',1)").run();
  sql.prepare("INSERT INTO command_results VALUES('customer','pay','secret-request','private-fingerprint','\"SECRET_CONTENT\"',?)").run(new Date().toISOString());
  sql.prepare("INSERT INTO job_queue(id,kind,payload,status,run_after,created_at) VALUES('secret-job','notification','SECRET_PAYLOAD','failed',?,?)").run(Date.now() - 600000, new Date().toISOString());
  sql.prepare("INSERT INTO job_queue(id,kind,payload,status,run_after,created_at) VALUES('pending-job','notification','{}','pending',?,?)").run(Date.now() - 600000, new Date().toISOString());
  const base = await listen(app);
  expect((await fetch(`${base}/api/admin/diagnostics`)).status).toBe(401);
  expect((await fetch(`${base}/api/admin/diagnostics`, { headers: { Cookie: "shopmate_user=customer" } })).status).toBe(401);
  expect((await fetch(`${base}/api/admin/diagnostics`, { headers: { Cookie: "shopmate_admin=staff" } })).status).toBe(403);
  const response = await fetch(`${base}/api/admin/diagnostics`, { headers: { Cookie: "shopmate_admin=owner" } });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.jobs).toMatchObject({ pending: 1, failed: 1 });
  expect(body.jobs.oldestWaitingMs).toBeGreaterThanOrEqual(600000);
  expect(body.storage.collections.commandResults).toMatchObject({ rows: 1, payloadBytes: 16, growthRows: null });
  expect(body.version).toMatchObject({ revisionRef: "test-revision" });
  expect(JSON.stringify(body)).not.toMatch(/SECRET_|private-fingerprint|secret-request|secret-job/);
  // A cached sample stays explicitly dated instead of implying immediate totals.
  sql.prepare("INSERT INTO command_results VALUES('customer','pay','second','fp','null',?)").run(new Date().toISOString());
  const cached = await (await fetch(`${base}/api/admin/diagnostics`, { headers: { Cookie: "shopmate_admin=owner" } })).json();
  expect(cached.storage.sampledAt).toBe(body.storage.sampledAt);
  expect(cached.storage.collections.commandResults.rows).toBe(1);
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 60001);
  const grown = await (await fetch(`${base}/api/admin/diagnostics`, { headers: { Cookie: "shopmate_admin=owner" } })).json();
  expect(grown.storage.collections.commandResults).toMatchObject({ rows: 2, growthRows: 1, growthPayloadBytes: 4 });
});
