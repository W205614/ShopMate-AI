/** Bounded observations only: this module performs no I/O and starts no timers. */
const MAX_SAMPLES = 2_000_000;
const CHUNK_SIZE = 65_536;

export interface RequestWindowSummary {
  startAt: number;
  endAt: number;
  count: number;
  writes: number;
  statusCounts: Record<string, number>;
  /** Non-2xx, including network status 0, but excluding separately counted 429. */
  errors: number;
  rejected: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  startedInWindow: number;
  finishedInWindow: number;
  dropped: number;
}

interface Chunk {
  starts: Float64Array;
  ends: Float64Array;
  statuses: Uint16Array;
  writes: Uint8Array;
}
const validTime = (value: number) =>
  Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
function assertWindow(startAt: number, endAt: number) {
  if (!validTime(startAt) || !validTime(endAt) || endAt < startAt)
    throw new RangeError("Invalid observation time window");
}

export class BoundedRequestTimeline {
  private chunks: Chunk[] = [];
  private sampleCount = 0;
  private droppedCount = 0;
  constructor(readonly maxSamples = MAX_SAMPLES) {
    if (
      !Number.isSafeInteger(maxSamples) ||
      maxSamples < 0 ||
      maxSamples > MAX_SAMPLES
    )
      throw new RangeError(`maxSamples must be between 0 and ${MAX_SAMPLES}`);
  }
  get count() {
    return this.sampleCount;
  }
  get dropped() {
    return this.droppedCount;
  }
  record(
    startAt: number,
    endAt: number,
    status: number,
    isWrite: boolean,
  ): void {
    assertWindow(startAt, endAt);
    if (
      !Number.isInteger(status) ||
      status < 0 ||
      status > 599 ||
      typeof isWrite !== "boolean"
    )
      throw new RangeError("Invalid request status or write flag");
    if (this.sampleCount === this.maxSamples) {
      this.droppedCount++;
      return;
    }
    const chunkIndex = Math.floor(this.sampleCount / CHUNK_SIZE),
      offset = this.sampleCount % CHUNK_SIZE;
    if (!this.chunks[chunkIndex]) {
      const size = Math.min(
        CHUNK_SIZE,
        this.maxSamples - chunkIndex * CHUNK_SIZE,
      );
      this.chunks.push({
        starts: new Float64Array(size),
        ends: new Float64Array(size),
        statuses: new Uint16Array(size),
        writes: new Uint8Array(size),
      });
    }
    const chunk = this.chunks[chunkIndex];
    chunk.starts[offset] = startAt;
    chunk.ends[offset] = endAt;
    chunk.statuses[offset] = status;
    chunk.writes[offset] = Number(isWrite);
    this.sampleCount++;
  }
  summarize(startAt: number, endAt: number): RequestWindowSummary {
    assertWindow(startAt, endAt);
    const result: RequestWindowSummary = {
      startAt,
      endAt,
      count: 0,
      writes: 0,
      statusCounts: {},
      errors: 0,
      rejected: 0,
      p50Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
      maxMs: 0,
      startedInWindow: 0,
      finishedInWindow: 0,
      dropped: this.dropped,
    };
    // At most 16 MB of temporary latency storage, independent of run duration.
    const latencies = new Float64Array(this.sampleCount);
    let remaining = this.sampleCount;
    for (const chunk of this.chunks) {
      const size = Math.min(remaining, chunk.starts.length);
      for (let i = 0; i < size; i++) {
        const start = chunk.starts[i],
          end = chunk.ends[i];
        // Closed intervals deliberately include requests spanning the whole backup.
        if (end < startAt || start > endAt) continue;
        const status = chunk.statuses[i];
        latencies[result.count++] = end - start;
        result.writes += chunk.writes[i];
        result.statusCounts[status] = (result.statusCounts[status] ?? 0) + 1;
        if (status === 429) result.rejected++;
        else if (status < 200 || status >= 300) result.errors++;
        if (start >= startAt && start <= endAt) result.startedInWindow++;
        if (end >= startAt && end <= endAt) result.finishedInWindow++;
      }
      remaining -= size;
    }
    const selected = latencies.subarray(0, result.count).sort();
    if (result.count) {
      const percentile = (p: number) =>
        selected[Math.ceil(result.count * p) - 1];
      result.p50Ms = percentile(0.5);
      result.p95Ms = percentile(0.95);
      result.p99Ms = percentile(0.99);
      result.maxMs = selected[result.count - 1];
    }
    return result;
  }
}

export interface BackupObservationEvent {
  event: "backup_started" | "backup_completed" | "backup_failed";
  at: string | number;
  backupId: string;
  file: string;
  durationMs?: number;
  bytes?: number;
}
export interface ObservedBackupWindow {
  startAt: number;
  endAt: number;
  fullyWithinLoad: boolean;
  stats: RequestWindowSummary;
}
export interface BackupWindowAnalysis {
  backupId: string;
  file: string;
  startAt: number;
  endAt: number;
  durationMs: number;
  observedDurationMs: number;
  bytes: number | null;
  entirelyWithinLoad: boolean;
  overlapWindow: ObservedBackupWindow;
  contextWindow: ObservedBackupWindow;
  passed: boolean;
  failures: string[];
}
export interface BackupObservationOptions {
  loadStartedAt: number;
  loadEndedAt: number;
  clockPaddingMs: number;
}
interface ParsedEvent extends Omit<BackupObservationEvent, "at"> {
  at: number;
  index: number;
}
interface BackupPair {
  start?: ParsedEvent;
  end?: ParsedEvent;
  starts: number;
  ends: number;
  failed: boolean;
}

export function analyzeBackupWindows(
  events: readonly unknown[],
  timeline: BoundedRequestTimeline,
  options: BackupObservationOptions,
) {
  const { loadStartedAt, loadEndedAt, clockPaddingMs } = options;
  assertWindow(loadStartedAt, loadEndedAt);
  if (!validTime(clockPaddingMs) || clockPaddingMs < 0)
    throw new RangeError("Invalid clock padding");
  const failures: string[] = [],
    backups: BackupWindowAnalysis[] = [],
    pairs = new Map<string, BackupPair>();
  // Bad/repeated log events must not turn the diagnostic itself into an unbounded buffer.
  const fail = (message: string) => {
    if (failures.length < 256) failures.push(message);
  };
  for (let index = 0; index < events.length; index++) {
    const raw = events[index];
    if (!raw || typeof raw !== "object") continue;
    const value = raw as Record<string, unknown>,
      kind = value.event;
    if (typeof kind !== "string" || !kind.startsWith("backup_")) continue;
    if (
      !["backup_started", "backup_completed", "backup_failed"].includes(kind)
    ) {
      fail(`Unsupported backup event at index ${index}`);
      continue;
    }
    const at = typeof value.at === "string" ? Date.parse(value.at) : value.at;
    if (
      typeof at !== "number" ||
      !validTime(at) ||
      typeof value.backupId !== "string" ||
      !value.backupId ||
      typeof value.file !== "string" ||
      !value.file
    ) {
      fail(`Invalid backup event at index ${index}`);
      continue;
    }
    const event = { ...value, at, index } as unknown as ParsedEvent;
    if (!pairs.has(event.backupId)) {
      if (pairs.size >= 1024) {
        fail("Too many distinct backup IDs");
        continue;
      }
      pairs.set(event.backupId, { starts: 0, ends: 0, failed: false });
    }
    const pair = pairs.get(event.backupId)!;
    if (kind === "backup_started") {
      pair.starts++;
      pair.start ??= event;
    }
    if (kind === "backup_completed") {
      pair.ends++;
      pair.end ??= event;
    }
    if (kind === "backup_failed") {
      pair.failed = true;
      fail(`Backup ${event.backupId} failed`);
    }
  }
  let completeBackupsInLoad = 0;
  for (const [backupId, pair] of pairs) {
    const problems: string[] = [];
    if (pair.starts !== 1)
      problems.push(pair.starts ? "duplicate starts" : "missing start");
    if (pair.ends !== 1)
      problems.push(pair.ends ? "duplicate completions" : "missing completion");
    const { start, end } = pair;
    if (start && end) {
      if (end.at < start.at || end.index < start.index)
        problems.push("completion precedes start");
      if (end.file !== start.file) problems.push("file mismatch");
      if (
        end.durationMs !== undefined &&
        (typeof end.durationMs !== "number" ||
          !Number.isFinite(end.durationMs) ||
          end.durationMs < 0)
      )
        problems.push("invalid duration");
      if (
        typeof end.bytes !== "number" ||
        !Number.isSafeInteger(end.bytes) ||
        end.bytes < 0
      )
        problems.push("missing or invalid completed bytes");
    }
    for (const problem of problems) fail(`Backup ${backupId}: ${problem}`);
    if (!start || !end || end.at < start.at) continue;
    const entirelyWithinLoad =
      start.at >= loadStartedAt && end.at <= loadEndedAt;
    const window = (padding: number): ObservedBackupWindow => {
      const startAt = start.at - padding,
        endAt = end.at + padding;
      return {
        startAt,
        endAt,
        fullyWithinLoad: startAt >= loadStartedAt && endAt <= loadEndedAt,
        stats: timeline.summarize(startAt, endAt),
      };
    };
    const overlapWindow = window(clockPaddingMs),
      contextWindow = window(Math.max(1000, clockPaddingMs));
    const windowFailures: string[] = [];
    if (entirelyWithinLoad) {
      if (!problems.length && !pair.failed) completeBackupsInLoad++;
      for (const [label, observed] of [
        ["overlap", overlapWindow],
        ["context", contextWindow],
      ] as const) {
        if (!observed.fullyWithinLoad)
          windowFailures.push(`${label} window is not fully covered by load`);
        if (!observed.stats.writes)
          windowFailures.push(`${label} window has no write requests`);
        if (observed.stats.errors)
          windowFailures.push(`${label} window has request errors`);
        if (observed.stats.rejected)
          windowFailures.push(`${label} window has 429 responses`);
        if (observed.stats.p95Ms > 2000)
          windowFailures.push(`${label} window P95 exceeds 2000ms`);
        if (observed.stats.p99Ms > 5000)
          windowFailures.push(`${label} window P99 exceeds 5000ms`);
      }
      for (const problem of windowFailures)
        fail(`Backup ${backupId}: ${problem}`);
    } else windowFailures.push("backup is not entirely within load");
    backups.push({
      backupId,
      file: start.file,
      startAt: start.at,
      endAt: end.at,
      durationMs:
        typeof end.durationMs === "number" &&
        Number.isFinite(end.durationMs) &&
        end.durationMs >= 0
          ? end.durationMs
          : end.at - start.at,
      observedDurationMs: end.at - start.at,
      bytes:
        typeof end.bytes === "number" &&
        Number.isSafeInteger(end.bytes) &&
        end.bytes >= 0
          ? end.bytes
          : null,
      entirelyWithinLoad,
      overlapWindow,
      contextWindow,
      passed:
        entirelyWithinLoad &&
        !pair.failed &&
        !problems.length &&
        !windowFailures.length &&
        !timeline.dropped,
      failures: [
        ...problems,
        ...(pair.failed ? ["backup failed"] : []),
        ...windowFailures,
      ],
    });
  }
  if (!completeBackupsInLoad) fail("No complete backup entirely within load");
  if (timeline.dropped)
    fail(`Request timeline dropped ${timeline.dropped} samples`);
  return {
    passed: failures.length === 0,
    failures,
    dropped: timeline.dropped,
    completeBackupsInLoad,
    backups,
  };
}
