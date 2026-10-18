import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BoundedRequestTimeline, analyzeBackupWindows } from "./load-observation";
import { observeProductionLoad } from "./production-load-observer";
const base = process.env.LOAD_BASE_URL ?? "",
  duration = Number(process.env.LOAD_SECONDS ?? "600"),
  concurrency = 50;
if (
  process.env.LOAD_TEST_ALLOWED !== "1" ||
  !/^http:\/\/(127\.0\.0\.1|localhost):18(08[89]|09[0-9])$/.test(base)
)
  throw new Error(
    "Explicit isolated acceptance URL is required; daily port18086 is forbidden",
  );
if (duration < 1 || duration > 1800) throw new Error("Invalid duration");
const headers = {
  "Content-Type": "application/json",
  "X-ShopMate-Request": "1",
};
const digestContainer = process.env.LOAD_CONTAINER;
const observeBackups = process.env.LOAD_OBSERVE_BACKUPS === "1";
if (observeBackups && !digestContainer?.startsWith("shopmate-reliability-"))
  throw new Error("An isolated production-load container is required");
const observer = observeBackups ? await observeProductionLoad(digestContainer!, base) : undefined;
const timeline = observeBackups ? new BoundedRequestTimeline() : undefined;
let serverSource: unknown;
if (digestContainer?.startsWith("shopmate-reliability-")) {
  const result = await promisify(execFile)("docker", [
    "exec",
    digestContainer,
    "node",
    "--input-type=module",
    "-e",
    `import fs from 'node:fs';import crypto from 'node:crypto';function files(p){return fs.readdirSync(p,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(p+'/'+e.name):[p+'/'+e.name]);}const paths=[...files('/app/backend/src'),...files('/app/shared'),'/app/backend/package.json','/app/backend/package-lock.json'].sort();const h=crypto.createHash('sha256'),zero=String.fromCharCode(0);for(const p of paths)h.update(p.slice(5)+zero).update(fs.readFileSync(p,'utf8').replaceAll(String.fromCharCode(13,10),String.fromCharCode(10))).update(zero);console.log(JSON.stringify({sha256:h.digest('hex'),files:paths.length,node:process.version}));`,
  ]);
  const metadata = await promisify(execFile)("docker", [
    "inspect",
    "--format",
    '{{.Image}}|{{index .Config.Labels "org.opencontainers.image.revision"}}',
    digestContainer,
  ]);
  const webContainer = digestContainer.replace(/-api-1$/, "-web-1");
  const proxyHash = await promisify(execFile)("docker", [
    "exec",
    webContainer,
    "sha256sum",
    "/etc/nginx/conf.d/default.conf",
  ]);
  const proxyImage = await promisify(execFile)("docker", [
    "inspect",
    "--format",
    "{{.Image}}",
    webContainer,
  ]);
  serverSource = {
    ...JSON.parse(result.stdout),
    image: metadata.stdout.trim(),
    proxySha256: proxyHash.stdout.trim().split(/\s+/)[0],
    proxyImage: proxyImage.stdout.trim(),
  };
}
const login = await fetch(base + "/api/auth/login", {
  method: "POST",
  headers,
  body: JSON.stringify({
    role: "user",
    username: "loaduser",
    password: process.env.LOAD_PASSWORD,
  }),
});
if (!login.ok) throw new Error("Load login failed");
const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
const auth = { ...headers, Cookie: cookie };
let requests = 0,
  errors = 0,
  rejected = 0;
const errorSamples: { status?: number; code?: string }[] = [];
const histogram = new Uint32Array(60001),
  statusCounts: Record<string, number> = {},
  stop = Date.now() + duration * 1000,
  start = Date.now();
const resourceSamples: { at: string; stats: string }[] = [];
const container = process.env.LOAD_CONTAINER;
let resourceSampleRunning = false;
const sample = () => {
  if (container?.startsWith("shopmate-reliability-") && !resourceSampleRunning) {
    resourceSampleRunning = true;
    execFile(
      "docker",
      ["stats", "--no-stream", "--format", "{{json .}}", container],
      { timeout: 10000 },
      (error, stdout) => {
        resourceSampleRunning = false;
        if (!error)
          resourceSamples.push({
            at: new Date().toISOString(),
            stats: stdout.trim(),
          });
      },
    );
  }
};
sample();
const resourceTimer = setInterval(sample, observeBackups ? 1000 : 30000);
async function worker(index: number) {
  let iteration = 0;
  while (Date.now() < stop) {
    const begin = performance.now(),
      beginAt = Date.now(),
      write = (iteration++ + index) % 10 === 0;
    let status = 0;
    try {
      const route = write
        ? "/api/actions/updateCart"
        : iteration % 3 === 0
          ? "/api/collections/orders?role=user&pageSize=20"
          : iteration % 3 === 1
            ? "/api/collections/products?pageSize=12"
            : "/api/member/points";
      const response = await fetch(base + route, {
        headers: auth,
        signal: AbortSignal.timeout(60000),
        ...(write
          ? {
              method: "POST",
              body: JSON.stringify({
                args: ["load-cart", { selected: iteration % 2 === 0 }],
                requestId: crypto.randomUUID(),
              }),
            }
          : {}),
      });
      await response.arrayBuffer();
      status = response.status;
      statusCounts[response.status] = (statusCounts[response.status] ?? 0) + 1;
      if (response.status === 429) rejected++;
      else if (!response.ok) {
        errors++;
        if (errorSamples.length < 5)
          errorSamples.push({ status: response.status });
      }
    } catch (error) {
      errors++;
      if (errorSamples.length < 5)
        errorSamples.push({
          code:
            error instanceof Error
              ? ((error.cause as { code?: string })?.code ?? error.name)
              : "UNKNOWN",
        });
      statusCounts.network = (statusCounts.network ?? 0) + 1;
    }
    histogram[Math.min(60000, Math.ceil(performance.now() - begin))]!++;
    timeline?.record(beginAt, beginAt + performance.now() - begin, status, write);
    requests++;
  }
}
const reportTimer = setInterval(
  () =>
    console.log(
      JSON.stringify({
        event: "load_progress",
        elapsedSeconds: Math.round((Date.now() - start) / 1000),
        requests,
        errors,
        rejected,
      }),
    ),
  60000,
);
await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)));
const loadEndedAt = Date.now();
clearInterval(reportTimer);
clearInterval(resourceTimer);
function percentile(p: number) {
  const threshold = Math.ceil(requests * p);
  let count = 0;
  for (let i = 0; i < histogram.length; i++) {
    count += histogram[i]!;
    if (count >= threshold) return i;
  }
  return 60000;
}
const report = {
  dataset: process.env.LOAD_HISTORY ?? "0",
  concurrency,
  startedAt: new Date(start).toISOString(),
  endedAt: new Date(loadEndedAt).toISOString(),
  elapsedSeconds: (loadEndedAt - start) / 1000,
  requests,
  requestsPerSecond: requests / ((loadEndedAt - start) / 1000),
  errors,
  rejected,
  statusCounts,
  errorSamples,
  p95Ms: percentile(0.95),
  p99Ms: percentile(0.99),
  resourceSamples,
  workload:
    "90% paged products/orders/points reads;10% idempotent cart selection writes",
  node: process.version,
  sha: process.env.VCS_REF ?? "working-tree",
  serverSource,
  serverState: container?.startsWith("shopmate-reliability-")
    ? JSON.parse(
        (
          await promisify(execFile)("docker", [
            "inspect",
            "--format",
            "{{json .State}}",
            container,
          ])
        ).stdout,
      )
    : undefined,
};
const observation = observer ? await observer.finish() : undefined;
const backupWindows = observation && timeline ? analyzeBackupWindows(observation.events, timeline, {
  loadStartedAt: start, loadEndedAt, clockPaddingMs: observation.clockPaddingMs,
}) : undefined;
const completeReport = { ...report, ...(observation ? { observation, backupWindows } : {}) };
const output = process.env.LOAD_REPORT ?? ".delivery/load.json";
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(completeReport, null, 2));
console.log(JSON.stringify(completeReport));
if (errors || report.p95Ms > 2000 || (observeBackups &&
  (rejected || !backupWindows?.passed || observation!.failures.length))) process.exitCode = 1;
