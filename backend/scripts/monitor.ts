import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { statfs, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

type Diagnostics = {
  jobs: { failed: number; oldestWaitingMs: number };
  backup: {
    enabled: boolean;
    replicaConfigured: boolean;
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
    lastErrorCode: string | null;
    lastReplicaSnapshotAt: string | null;
  };
};
export type Probe = {
  health: boolean;
  latencyMs: number;
  containers: boolean;
  diskFreeRatio: number;
  diagnostics?: Diagnostics;
  diagnosticsUnavailable?: boolean;
};
export function evaluateProbe(probe: Probe, now = Date.now()) {
  const issues: string[] = [];
  if (!probe.health) issues.push("HEALTH_FAILED");
  else if (probe.latencyMs > 2000) issues.push("HEALTH_SLOW");
  if (!probe.containers) issues.push("CONTAINER_UNHEALTHY");
  if (probe.diskFreeRatio < 0.2) issues.push("DISK_LOW");
  if (probe.diagnosticsUnavailable || !probe.diagnostics)
    issues.push("DIAGNOSTICS_UNAVAILABLE");
  if (probe.diagnostics) {
    const { jobs, backup } = probe.diagnostics;
    if (jobs.failed > 0) issues.push("JOB_FAILED");
    if (jobs.oldestWaitingMs > 300000) issues.push("JOB_STALLED");
    if (!backup.enabled) issues.push("BACKUP_DISABLED");
    else {
      const success = backup.lastSuccessAt
        ? Date.parse(backup.lastSuccessAt)
        : NaN;
      if (
        !Number.isFinite(success) ||
        success > now ||
        now - success > 23 * 3600000
      )
        issues.push("BACKUP_STALE");
      if (backup.lastErrorCode) issues.push("BACKUP_FAILED");
    }
    // Local success must never mask a missing or older receiving-side recovery point,
    // including a process exit between the local-created and replica-created messages.
    if (backup.replicaConfigured) {
      const replica = backup.lastReplicaSnapshotAt
        ? Date.parse(backup.lastReplicaSnapshotAt)
        : NaN;
      if (
        !Number.isFinite(replica) ||
        replica > now ||
        now - replica > 23 * 3600000
      )
        issues.push("REPLICA_STALE");
    }
  }
  return issues.sort();
}

/** Confirm each individual issue three times; an unrelated intermittent failure cannot trip it. */
export class AlertTracker {
  private failures = new Map<string, number>();
  private alerted = "";
  update(issues: string[], maintenance = false) {
    if (maintenance) {
      this.failures.clear();
      this.alerted = "";
      return null;
    }
    const current = new Set(issues);
    for (const issue of this.failures.keys())
      if (!current.has(issue)) this.failures.delete(issue);
    for (const issue of current)
      this.failures.set(issue, (this.failures.get(issue) ?? 0) + 1);
    const confirmed = [...this.failures]
      .filter(([, count]) => count >= 3)
      .map(([issue]) => issue)
      .sort();
    const signature = confirmed.join(",");
    if (signature === this.alerted) return null;
    const recovering = !!this.alerted && !signature;
    this.alerted = signature;
    return {
      event: recovering ? "monitor_recovered" : "monitor_alert",
      issues: confirmed,
    };
  }
}

const execute = promisify(execFile);
async function probe(base: string, cookie: string): Promise<Probe> {
  const start = performance.now();
  let health = false,
    diagnostics: Diagnostics | undefined;
  try {
    const response = await fetch(`${base}/api/health`, {
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
    health = response.ok && (await response.json()).status === "ok";
  } catch {
    /* Only fixed failure codes are emitted. */
  }
  const latencyMs = Math.round(performance.now() - start);
  try {
    const response = await fetch(`${base}/api/admin/diagnostics`, {
      headers: { Cookie: cookie },
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
    if (response.ok) {
      const body = await response.json();
      if (
        typeof body.jobs?.failed === "number" &&
        typeof body.jobs?.oldestWaitingMs === "number" &&
        typeof body.backup?.enabled === "boolean"
      )
        diagnostics = body;
    }
  } catch {
    /* A login expiry must be visible as a probe failure. */
  }
  let containers = false;
  try {
    const project = process.env.MONITOR_COMPOSE_PROJECT ?? "shopmate-ai";
    const names = [
      process.env.MONITOR_API_CONTAINER ?? `${project}-api-1`,
      process.env.MONITOR_WEB_CONTAINER ?? `${project}-web-1`,
    ];
    const { stdout } = await execute(
      "docker",
      ["inspect", "--format", "{{json .State}}", ...names],
      { timeout: 10000, maxBuffer: 100000 },
    );
    const states = stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    containers =
      states.length === 2 &&
      states.every(
        (state) =>
          state.Running &&
          !state.OOMKilled &&
          (!state.Health || state.Health.Status === "healthy"),
      );
  } catch {
    /* No docker output is logged: it can contain environment credentials. */
  }
  let diskFreeRatio = 0;
  try {
    const paths = (process.env.MONITOR_DISK_PATHS ?? process.cwd())
      .split(",")
      .filter(Boolean);
    const ratios = await Promise.all(
      paths.map(async (path) => {
        const fs = await statfs(resolve(path));
        return fs.blocks > 0 ? fs.bavail / fs.blocks : 0;
      }),
    );
    diskFreeRatio = Math.min(...ratios);
  } catch {
    /* Unreadable storage is an actionable low-space probe. */
  }
  return {
    health,
    latencyMs,
    containers,
    diskFreeRatio,
    diagnostics,
    diagnosticsUnavailable: !diagnostics,
  };
}

async function maintenance() {
  let until = process.env.MONITOR_MAINTENANCE_UNTIL;
  try {
    const content = await readFile(
      process.env.MONITOR_MAINTENANCE_FILE ?? ".local/monitor-maintenance.json",
      "utf8",
    );
    if (content.length <= 1024) until = JSON.parse(content).until;
  } catch {
    /* A missing/invalid marker never silently enables maintenance. */
  }
  const deadline = typeof until === "string" ? Date.parse(until) : NaN;
  return Number.isFinite(deadline) && deadline > Date.now();
}

async function login(base: string) {
  if (process.env.MONITOR_ADMIN_COOKIE) return process.env.MONITOR_ADMIN_COOKIE;
  if (!process.env.MONITOR_ADMIN_PASSWORD) return "";
  try {
    const response = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-ShopMate-Request": "1",
      },
      body: JSON.stringify({
        role: "admin",
        username: process.env.MONITOR_ADMIN_USERNAME ?? "admin",
        password: process.env.MONITOR_ADMIN_PASSWORD,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    await response.body?.cancel();
    return response.ok
      ? response.headers
          .getSetCookie()
          .map((value) => value.split(";", 1)[0])
          .join("; ")
      : "";
  } catch {
    return "";
  }
}

export async function runMonitor(once = false) {
  const base = (
    process.env.MONITOR_BASE_URL ?? "http://127.0.0.1:18086"
  ).replace(/\/$/, "");
  const url = new URL(base);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("MONITOR_BASE_INVALID");
  if (
    url.protocol !== "https:" &&
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  )
    throw new Error("MONITOR_REQUIRES_HTTPS");
  const webhook = process.env.MONITOR_WEBHOOK_URL;
  if (webhook && new URL(webhook).protocol !== "https:")
    throw new Error("MONITOR_WEBHOOK_REQUIRES_HTTPS");
  console.log(
    JSON.stringify({
      event: "monitor_started",
      intervalMs: 60000,
      alertDelivery: webhook ? "configured" : "unconfigured",
      message: webhook ? "告警已配置" : "告警未接通",
    }),
  );
  const tracker = new AlertTracker();
  let cookie = await login(base),
    lastLogin = Date.now(),
    lastMaintenance = false;
  let pendingDelivery:
    { event: string; issues: string[]; at: string } | undefined;
  do {
    const cycleStarted = Date.now();
    const muted = await maintenance();
    if (muted !== lastMaintenance)
      console.log(
        JSON.stringify({ event: "monitor_maintenance", active: muted }),
      );
    lastMaintenance = muted;
    let result: Probe | undefined;
    if (!muted) {
      result = await probe(base, cookie);
      if (
        result.diagnosticsUnavailable &&
        process.env.MONITOR_ADMIN_PASSWORD &&
        Date.now() - lastLogin >= 60000
      ) {
        cookie = await login(base);
        lastLogin = Date.now();
      }
    }
    const issues = result ? evaluateProbe(result) : [];
    const event = tracker.update(issues, muted);
    if (muted) pendingDelivery = undefined;
    if (event) {
      const payload = { ...event, at: new Date().toISOString() };
      console.log(JSON.stringify(payload));
      pendingDelivery = payload;
    }
    if (webhook && pendingDelivery && !muted)
      try {
        const response = await fetch(webhook, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(pendingDelivery),
          redirect: "error",
          signal: AbortSignal.timeout(5000),
        });
        await response.body?.cancel();
        if (!response.ok) throw new Error();
        pendingDelivery = undefined;
      } catch {
        console.error(
          JSON.stringify({
            event: "monitor_delivery_failed",
            code: "WEBHOOK_FAILED",
          }),
        );
      }
    if (once) {
      console.log(
        JSON.stringify({
          event: "monitor_probe",
          maintenance: muted,
          issues,
          latencyMs: result?.latencyMs ?? null,
        }),
      );
      if (issues.length) process.exitCode = 1;
      return;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, 60000 - (Date.now() - cycleStarted))),
    );
  } while (true);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  runMonitor(process.argv.includes("--once")).catch(() => {
    console.error(
      JSON.stringify({
        event: "monitor_failed",
        code: "MONITOR_CONFIG_OR_RUNTIME_ERROR",
      }),
    );
    process.exitCode = 1;
  });
