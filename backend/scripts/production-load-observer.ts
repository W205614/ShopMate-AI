import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";

/** Retain only a bounded probe-era history: its log can precede the HTTP response. */
export class BoundedRequestMarker {
  private recent = new Set<string>();
  private slots: string[] = [];
  private next = 0;
  private expected = "";
  private matched = false;
  constructor(private readonly capacity = 16_384) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 16_384)
      throw new RangeError("Invalid marker history capacity");
  }
  get seen() {
    return this.matched;
  }
  get size() {
    return this.recent.size;
  }
  expect(requestId: unknown) {
    if (
      typeof requestId !== "string" ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(requestId)
    )
      return false;
    this.expected = requestId;
    this.matched = this.recent.has(requestId);
    return true;
  }
  record(requestId: unknown) {
    if (
      typeof requestId !== "string" ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(requestId)
    )
      return;
    if (requestId === this.expected) this.matched = true;
    if (this.recent.has(requestId)) return;
    const previous = this.slots[this.next];
    if (previous !== undefined) this.recent.delete(previous);
    this.slots[this.next] = requestId;
    this.next = (this.next + 1) % this.capacity;
    this.recent.add(requestId);
  }
}

const execute = promisify(execFile);
async function inspect(name: string) {
  const result = await execute("docker", ["inspect", name], {
    maxBuffer: 2 * 1024 * 1024,
    timeout: 15000,
  });
  return JSON.parse(result.stdout)[0];
}
export async function measureContainerClock(container: string) {
  const start = Date.now();
  const result = await execute(
    "docker",
    ["exec", container, "node", "-e", "console.log(Date.now())"],
    { timeout: 10000 },
  );
  const end = Date.now(),
    serverAt = Number(result.stdout.trim());
  if (!Number.isFinite(serverAt))
    throw new Error("Container clock measurement failed");
  return {
    at: end,
    offsetMs: serverAt - (start + end) / 2,
    uncertaintyMs: (end - start) / 2,
  };
}

/** Captures only redacted lifecycle events/counters, before Docker log rotation can discard them. */
export async function observeProductionLoad(container: string, base: string) {
  const api = await inspect(container),
    webName = container.replace(/-api-1$/, "-web-1"),
    web = await inspect(webName);
  const project = api.Config.Labels["com.docker.compose.project"] as string;
  const env = Object.fromEntries(
    (api.Config.Env as string[]).map((value) => {
      const index = value.indexOf("=");
      return [value.slice(0, index), value.slice(index + 1)];
    }),
  );
  const backups = api.Mounts.find(
    (mount: any) => mount.Destination === "/app/backups",
  );
  const data = api.Mounts.find(
    (mount: any) => mount.Destination === "/app/data",
  );
  const bindings = web.NetworkSettings.Ports["80/tcp"] ?? [];
  const log = api.HostConfig.LogConfig;
  if (
    !/^shopmate-reliability-[a-z0-9-]+$/.test(project) ||
    container !== project + "-api-1" ||
    api.Config.Labels["shopmate.acceptance"] !== "production-load" ||
    web.Config.Labels["com.docker.compose.project"] !== project ||
    !bindings.some(
      (binding: any) =>
        binding.HostIp === "127.0.0.1" &&
        binding.HostPort === new URL(base).port,
    ) ||
    env.SHOPMATE_ENV !== "acceptance" ||
    env.LOG_REQUESTS !== "true" ||
    env.BACKUP_DIR !== "/app/backups" ||
    env.ALLOW_LEGACY_COMMANDS !== "false" ||
    data?.Type !== "volume" ||
    data.Name !== project + "_api_data" ||
    backups?.Type !== "bind" ||
    !backups.RW ||
    !String(backups.Source).includes(project) ||
    api.HostConfig.Memory !== 1024 * 1024 * 1024 ||
    api.HostConfig.PidsLimit !== 128 ||
    log.Type !== "json-file" ||
    log.Config["max-size"] !== "10m" ||
    log.Config["max-file"] !== "3"
  )
    throw new Error(
      "Production-load isolation or daily-default settings are not satisfied",
    );

  const settings = {
    project,
    apiRequestLogs: true,
    automaticBackups: true,
    nginxAccessLogs: true,
    persistentJobs: true,
    idempotencyRequired: true,
    memoryBytes: api.HostConfig.Memory,
    pidsLimit: api.HostConfig.PidsLimit,
    logging: log,
    independentBackupBind: true,
    initialRestartCount: api.RestartCount,
    apiStartedAt: api.State.StartedAt,
  };
  const events: {
    event: string;
    at: string;
    backupId: string;
    file: string;
    durationMs?: number;
    bytes?: number;
  }[] = [];
  const failures: string[] = [],
    statusCounts: Record<string, number> = {};
  const httpExamples: unknown[] = [];
  const marker = new BoundedRequestMarker();
  let httpCount = 0,
    capturingMarker = false,
    stopping = false;
  const child = spawn(
    "docker",
    ["logs", "--follow", "--since", new Date().toISOString(), container],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const cleanup = () => {
    stopping = true;
    child.kill();
  };
  process.once("exit", cleanup);
  const addFailure = (code: string) => {
    if (failures.length < 20) failures.push(code);
  };
  for (const stream of [child.stdout!, child.stderr!]) {
    const lines = createInterface({ input: stream });
    lines.on("line", (line) => {
      if (line.length > 64 * 1024) {
        addFailure("oversized_log_line");
        return;
      }
      let value: any;
      try {
        value = JSON.parse(line);
      } catch {
        return;
      }
      if (value.event === "http") {
        httpCount++;
        statusCounts[value.status] = (statusCounts[value.status] ?? 0) + 1;
        if (httpExamples.length < 3)
          httpExamples.push({
            event: value.event,
            method: value.method,
            path: value.path,
            status: value.status,
            durationMs: value.durationMs,
            requestId: value.requestId,
          });
        if (capturingMarker) marker.record(value.requestId);
      }
      if (
        ["backup_started", "backup_completed", "backup_failed"].includes(
          value.event,
        )
      ) {
        if (events.length >= 100) {
          addFailure("too_many_backup_events");
          return;
        }
        events.push({
          event: value.event,
          at: value.at,
          backupId: value.backupId,
          file: value.file,
          ...(value.durationMs !== undefined
            ? { durationMs: value.durationMs }
            : {}),
          ...(value.bytes !== undefined ? { bytes: value.bytes } : {}),
        });
      }
    });
  }
  child.on("error", () => addFailure("docker_log_stream_error"));
  child.on("close", () => {
    if (!stopping) addFailure("docker_log_stream_closed_early");
  });
  const clockBefore = await measureContainerClock(container);
  return {
    settings,
    events,
    clockBefore,
    async finish() {
      capturingMarker = true;
      try {
        const response = await fetch(base + "/api/live", {
          signal: AbortSignal.timeout(5000),
        });
        // Nginx replaces client-supplied IDs; correlate with the actual API response.
        if (!marker.expect(response.headers.get("X-Request-ID")))
          addFailure("final_log_marker_request_id_missing");
        await response.arrayBuffer();
        if (!response.ok) addFailure("final_log_marker_request_failed");
      } catch {
        addFailure("final_log_marker_request_failed");
      }
      const deadline = Date.now() + 3000;
      while (!marker.seen && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      if (!marker.seen) addFailure("log_capture_not_caught_up");
      capturingMarker = false;
      const clockAfter = await measureContainerClock(container);
      const clockPaddingMs =
        Math.ceil(
          Math.max(
            Math.abs(clockBefore.offsetMs) + clockBefore.uncertaintyMs,
            Math.abs(clockAfter.offsetMs) + clockAfter.uncertaintyMs,
          ),
        ) + 100;
      if (Math.abs(clockAfter.offsetMs - clockBefore.offsetMs) > 250)
        addFailure("unstable_container_clock");
      cleanup();
      process.off("exit", cleanup);
      const finalApi = await inspect(container);
      const memoryPeak = await execute(
        "docker",
        ["exec", container, "cat", "/sys/fs/cgroup/memory.peak"],
        { timeout: 10000 },
      );
      if (
        finalApi.RestartCount !== api.RestartCount ||
        finalApi.State.OOMKilled ||
        finalApi.State.Health?.Status !== "healthy"
      )
        addFailure("container_restarted_or_unhealthy");
      if (!httpCount) addFailure("no_api_request_logs_observed");
      return {
        settings,
        events,
        failures,
        httpCount,
        statusCounts,
        httpExamples,
        markerSeen: marker.seen,
        clockBefore,
        clockAfter,
        clockPaddingMs,
        finalRestartCount: finalApi.RestartCount,
        kernelPeakMemoryBytes: Number(memoryPeak.stdout.trim()),
        finalImage: finalApi.Image,
        finalState: finalApi.State,
      };
    },
  };
}
