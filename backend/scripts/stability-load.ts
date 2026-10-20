/** Paced, multi-user transaction soak. Only runs against a verified isolated Compose project. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  BoundedRequestTimeline,
  analyzeBackupWindows,
} from "./load-observation";
import { observeProductionLoad } from "./production-load-observer";

const execute = promisify(execFile),
  base = process.env.LOAD_BASE_URL ?? "",
  container = process.env.LOAD_CONTAINER ?? "";
if (
  process.env.LOAD_TEST_ALLOWED !== "1" ||
  !/^http:\/\/(localhost|127\.0\.0\.1):1809[0-9]$/.test(base) ||
  !/^shopmate-reliability-[a-z0-9-]+-api-1$/.test(container)
)
  throw new Error("Explicit isolated stability deployment required");
const smoke = process.env.STABILITY_SMOKE === "1";
const phases = smoke
  ? [{ concurrency: 5, seconds: 120, paceMs: 500 }]
  : [
      { concurrency: 5, seconds: 600, paceMs: 0 },
      { concurrency: 20, seconds: 600, paceMs: 0 },
      { concurrency: 50, seconds: 600, paceMs: 0 },
      { concurrency: 20, seconds: 5400, paceMs: 500 },
    ];
const reportPath = process.env.LOAD_REPORT ?? ".delivery/stability/load.json";
const observer = await observeProductionLoad(container, base);
const imageRevision = (
  await execute("docker", [
    "inspect",
    "--format",
    '{{index .Config.Labels "org.opencontainers.image.revision"}}',
    container,
  ])
).stdout.trim();
if (imageRevision !== process.env.VCS_REF)
  throw new Error("ACCEPTANCE_REVISION_MISMATCH");
const timeline = new BoundedRequestTimeline();
const headers = {
  "Content-Type": "application/json",
  "X-ShopMate-Request": "1",
};
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
const requestStats = {
  reads: 0,
  writes: 0,
  errors: 0,
  rejected: 0,
  requests: 0,
};
const errors: { status: number; code: string; route: string }[] = [];
const histogram = new Uint32Array(60001),
  statusCounts: Record<string, number> = {};
const normalRoutes: Record<string, number> = {};
let recording = false;
let currentHistogram = new Uint32Array(60001),
  currentRequests = 0,
  currentErrors = 0,
  currentRejected = 0;
const samples: unknown[] = [],
  faults: unknown[] = [],
  results: unknown[] = [];
const pct = (h: Uint32Array, n: number, fraction: number) => {
  let count = 0;
  for (let i = 0; i < h.length; i++) {
    count += h[i]!;
    if (count >= Math.ceil(n * fraction)) return i;
  }
  return 0;
};
async function request(
  cookie: string,
  path: string,
  body?: unknown,
  fault = false,
) {
  const startedAt = Date.now(),
    start = performance.now();
  let status = 0;
  try {
    const response = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { ...headers, Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    status = response.status;
    const text = await response.text();
    let value: any;
    try {
      value = JSON.parse(text);
    } catch {
      value = { code: "INVALID_JSON_RESPONSE" };
    }
    if (!response.ok) {
      if (!fault && recording) {
        if (status === 429) {
          requestStats.rejected++;
          currentRejected++;
        } else {
          requestStats.errors++;
          currentErrors++;
        }
        if (errors.length < 20)
          errors.push({
            status,
            code: String(value.code ?? "HTTP_ERROR"),
            route: path.split("?")[0]!,
          });
      }
      throw new Error(`HTTP_${status}`);
    }
    return value;
  } catch (error) {
    if (!status && !fault && recording) {
      requestStats.errors++;
      currentErrors++;
      if (errors.length < 20)
        errors.push({
          status: 0,
          code: "NETWORK_ERROR",
          route: path.split("?")[0]!,
        });
    }
    throw error;
  } finally {
    if (recording && !fault) {
      const elapsed = Math.min(60000, Math.ceil(performance.now() - start));
      histogram[elapsed]!++;
      currentHistogram[elapsed]!++;
      currentRequests++;
      requestStats.requests++;
      requestStats[body === undefined ? "reads" : "writes"]++;
      statusCounts[status] = (statusCounts[status] ?? 0) + 1;
      const key = path.split("?")[0]!;
      normalRoutes[key] = (normalRoutes[key] ?? 0) + 1;
      timeline.record(
        startedAt,
        startedAt + performance.now() - start,
        status,
        body !== undefined,
      );
    }
  }
}
async function login(
  role: "user" | "admin",
  username: string,
  password: string | undefined,
) {
  const response = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers,
    body: JSON.stringify({ role, username, password }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`LOGIN_${role}_${response.status}`);
  return response.headers.get("set-cookie")!.split(";")[0]!;
}
const admin = await login(
  "admin",
  process.env.LOAD_ADMIN_USERNAME ?? "admin",
  process.env.LOAD_ADMIN_PASSWORD,
);
const cookies: string[] = [];
for (let i = 0; i < 50; i++)
  cookies.push(
    await login("user", `stability_${i}`, process.env.LOAD_PASSWORD),
  );
const action = (
  cookie: string,
  method: string,
  args: unknown[],
  fault = false,
) =>
  request(
    cookie,
    `/api/actions/${method}`,
    { args, requestId: crypto.randomUUID() },
    fault,
  ).then((r) => r.result);
const diagnostics = () =>
  request(admin, "/api/admin/diagnostics", undefined, true);
async function resourceSample() {
  try {
    const stats = await execute(
      "docker",
      ["stats", "--no-stream", "--format", "{{json .}}", container],
      { timeout: 10000 },
    );
    const diag = await diagnostics();
    const item = {
      at: new Date().toISOString(),
      stats: JSON.parse(stats.stdout),
      diagnostics: diag,
    };
    samples.push(item);
    console.log(
      JSON.stringify({
        event: "stability_progress",
        at: item.at,
        requests: requestStats.requests,
        errors: requestStats.errors,
        rejected: requestStats.rejected,
        p95Ms: pct(histogram, requestStats.requests, 0.95),
        pendingJobs: diag.jobs.pending,
        oldestJobMs: diag.jobs.oldestWaitingMs,
      }),
    );
  } catch {
    faults.push({ event: "observation_failed", at: new Date().toISOString() });
  }
}
let injecting = false,
  faultIndex = 0;
async function injectFault() {
  if (injecting) return;
  injecting = true;
  try {
    const uid = 40 + (faultIndex++ % 10),
      cookie = cookies[uid]!;
    const conversation = await action(cookie, "createConversation", [{}], true);
    await action(
      cookie,
      "sendMessage",
      [conversation, "请说明本店退货规则"],
      true,
    );
    const data = await request(
      cookie,
      `/api/support/conversations/${encodeURIComponent(conversation)}`,
      undefined,
      true,
    );
    faults.push({
      event: "support_fault_enqueued",
      at: new Date().toISOString(),
      runStatus: data.run?.status ?? "queued",
    });
  } catch {
    faults.push({
      event: "fault_injection_request_failed",
      at: new Date().toISOString(),
    });
  } finally {
    injecting = false;
  }
}
const startedAt = Date.now();
recording = true;
await resourceSample();
const sampler = setInterval(() => {
  void resourceSample();
}, 60000);
const faultTimer = setInterval(() => {
  void injectFault();
}, 60000);
await injectFault();
// TXT indexing must fail safely while the ordinary load remains active.
try {
  await request(
    admin,
    "/api/support/documents",
    {
      name: "stability-fault.txt",
      contentBase64: Buffer.from(
        "这是隔离验收知识资料，不得发布。".repeat(80),
      ).toString("base64"),
      requestId: crypto.randomUUID(),
    },
    true,
  );
  faults.push({
    event: "document_fault_enqueued",
    at: new Date().toISOString(),
  });
} catch {
  faults.push({
    event: "document_fault_injection_failed",
    at: new Date().toISOString(),
  });
}

interface Flow {
  quote?: string;
  order?: string;
  sale?: string;
  step: number;
  iteration: number;
  transactions: number;
}
const flows: Flow[] = Array.from({ length: 50 }, () => ({
  step: 0,
  iteration: 0,
  transactions: 0,
}));
try {
  for (const phase of phases) {
    const writesBefore = requestStats.writes,
      readsBefore = requestStats.reads;
    const begin = Date.now(),
      end = begin + phase.seconds * 1000;
    currentHistogram = new Uint32Array(60001);
    currentRequests = 0;
    currentErrors = 0;
    currentRejected = 0;
    async function worker(index: number) {
      const cookie = cookies[index]!,
        flow = flows[index]!,
        uid = `stability-${index}`;
      const quoteInput = {
        addressId: `${uid}-address`,
        source: {
          type: "buyNow",
          productId: "p01",
          skuId: "p01-s1",
          quantity: 1,
        },
      };
      while (Date.now() < end) {
        const slot = flow.iteration++ % 10;
        try {
          if (slot < 7) {
            const path =
              slot % 3 === 0
                ? "/api/collections/products?pageSize=12"
                : slot % 3 === 1
                  ? "/api/collections/orders?role=user&pageSize=20"
                  : "/api/member/points";
            await request(cookie, path);
          } else if (slot === 7) {
            await action(cookie, "updateCart", [
              `${uid}-cart-0`,
              { selected: flow.iteration % 2 === 0 },
            ]);
          } else if (slot === 8) {
            const quote = await action(cookie, "quoteCheckout", [quoteInput]);
            if (!flow.order) flow.quote = quote.id;
          } else if (!flow.order) {
            if (!flow.quote)
              flow.quote = (
                await action(cookie, "quoteCheckout", [quoteInput])
              ).id;
            flow.order = await action(cookie, "createOrder", [
              { quoteId: flow.quote, requestId: crypto.randomUUID() },
            ]);
            flow.step = 1;
          } else if (flow.step === 1 && (index + flow.transactions) % 2 === 0) {
            await action(cookie, "cancelOrder", [flow.order]);
            flow.order = undefined;
            flow.quote = undefined;
            flow.transactions++;
          } else if (flow.step === 1) {
            await action(cookie, "payOrder", [flow.order]);
            flow.step = 2;
          } else if (flow.step === 2) {
            const detail = await request(
              cookie,
              `/api/collections/orders?role=user&id=${encodeURIComponent(flow.order)}&pageSize=1`,
            );
            const item = detail.items[0].items[0];
            await action(cookie, "requestAfterSale", [
              flow.order,
              "隔离验收",
              "未发货退款守恒验收",
              [{ orderItemId: item.id, quantity: 1 }],
            ]);
            const sale = await request(
              cookie,
              `/api/collections/afterSales?role=user&orderId=${encodeURIComponent(flow.order)}&pageSize=100`,
            );
            flow.sale = sale.items.find(
              (s: any) => s.orderId === flow.order,
            )?.id;
            if (!flow.sale) throw new Error("SALE_RESULT_MISSING");
            flow.step = 3;
          } else if (flow.step === 3) {
            await action(admin, "processAfterSale", [flow.sale, "approve"]);
            flow.step = 4;
          } else {
            await action(admin, "processAfterSale", [flow.sale, "refund"]);
            flow.order = undefined;
            flow.quote = undefined;
            flow.sale = undefined;
            flow.transactions++;
          }
        } catch (error) {
          if (
            errors.length < 20 &&
            !(error instanceof Error && error.message.startsWith("HTTP_"))
          )
            errors.push({
              status: 0,
              code: "WORKFLOW_FAILED",
              route: "state-machine",
            });
        }
        // Capacity phases use closed loops; the endurance phase includes user think time.
        if (phase.paceMs) await pause(phase.paceMs);
      }
    }
    await Promise.all(
      Array.from({ length: phase.concurrency }, (_, index) => worker(index)),
    );
    const result = {
      ...phase,
      startedAt: new Date(begin).toISOString(),
      endedAt: new Date().toISOString(),
      requests: currentRequests,
      writes: requestStats.writes - writesBefore,
      reads: requestStats.reads - readsBefore,
      errors: currentErrors,
      rejected: currentRejected,
      p95Ms: pct(currentHistogram, currentRequests, 0.95),
      p99Ms: pct(currentHistogram, currentRequests, 0.99),
    };
    results.push(result);
    console.log(
      JSON.stringify({ event: "stability_phase_completed", ...result }),
    );
  }
} finally {
  clearInterval(sampler);
  clearInterval(faultTimer);
}
recording = false;
const endedAt = Date.now();
await resourceSample();
const observation = await observer.finish();
const backupWindows = analyzeBackupWindows(observation.events, timeline, {
  loadStartedAt: startedAt,
  loadEndedAt: endedAt,
  clockPaddingMs: observation.clockPaddingMs,
});
const state = JSON.parse(
  (
    await execute("docker", [
      "inspect",
      "--format",
      "{{json .State}}",
      container,
    ])
  ).stdout,
);
const restartCount = Number(
  (
    await execute("docker", [
      "inspect",
      "--format",
      "{{.RestartCount}}",
      container,
    ])
  ).stdout.trim(),
);
const providerContainer = container.replace(/-api-1$/, "-provider-1");
const providerOutput = await execute(
  "docker",
  ["logs", "--since", new Date(startedAt).toISOString(), providerContainer],
  { maxBuffer: 1024 * 1024 },
);
const providerModes: Record<string, number> = {};
for (const line of providerOutput.stdout.split(/\r?\n/)) {
  try {
    const event = JSON.parse(line);
    if (event.event === "provider_fault")
      providerModes[event.mode] = (providerModes[event.mode] ?? 0) + 1;
  } catch {
    /* Ignore runtime notices. */
  }
}
const finalDiagnostics = (samples.at(-1) as any)?.diagnostics;
const faultCoverage =
  faults.some((f: any) => f.event === "support_fault_enqueued") &&
  faults.some((f: any) => f.event === "document_fault_enqueued") &&
  !faults.some((f: any) => f.event.includes("failed")) &&
  (smoke ||
    ["http429", "invalid_json", "timeout", "http503"].every(
      (mode) => providerModes[mode] > 0,
    )) &&
  finalDiagnostics?.ai.support.some(
    (s: any) => s.status === "failed" && s.count > 0,
  ) &&
  finalDiagnostics?.ai.documents.some(
    (s: any) => s.status === "failed" && s.count > 0,
  );
const queuesHealthy = samples.every(
  (s: any) =>
    s.diagnostics.jobs.failed === 0 &&
    s.diagnostics.jobs.oldestWaitingMs <= 300000,
);
const passed =
  !requestStats.errors &&
  !requestStats.rejected &&
  !errors.length &&
  faultCoverage &&
  queuesHealthy &&
  results.every((r: any) => r.p95Ms <= 2000 && r.p99Ms <= 5000) &&
  backupWindows.passed &&
  !observation.failures.length &&
  !state.OOMKilled &&
  restartCount === observation.settings.initialRestartCount &&
  state.Health?.Status === "healthy";
const report = {
  schema: 1,
  smoke,
  passed,
  sourceCommit: imageRevision,
  startedAt: new Date(startedAt).toISOString(),
  endedAt: new Date(endedAt).toISOString(),
  elapsedSeconds: (endedAt - startedAt) / 1000,
  arrivalPace: "capacity phases closed-loop; endurance phase 500ms think time",
  workload:
    "70% reads;20% cart/quote;10% transaction state-machine iterations (extra detail reads counted separately)",
  ...requestStats,
  p95Ms: pct(histogram, requestStats.requests, 0.95),
  p99Ms: pct(histogram, requestStats.requests, 0.99),
  errorSamples: errors,
  statusCounts,
  routes: normalRoutes,
  phases: results,
  completedTransactions: flows.reduce((n, f) => n + f.transactions, 0),
  samples,
  faults,
  faultCoverage,
  providerModes,
  queuesHealthy,
  backupWindows,
  observation,
  state,
  restartCount,
};
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(
  JSON.stringify({
    event: "stability_completed",
    passed,
    reportPath,
    requests: requestStats.requests,
    elapsedSeconds: report.elapsedSeconds,
  }),
);
if (!passed) process.exitCode = 1;
