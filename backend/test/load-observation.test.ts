import { describe, expect, it } from "vitest";
import {
  BoundedRequestTimeline,
  analyzeBackupWindows,
  type BackupObservationEvent,
} from "../scripts/load-observation";

const options = { loadStartedAt: 0, loadEndedAt: 20_000, clockPaddingMs: 100 };
const events = (
  id = "backup-a",
  start = 5000,
  end = 5100,
): BackupObservationEvent[] => [
  { event: "backup_started", at: start, backupId: id, file: `${id}.sqlite` },
  {
    event: "backup_completed",
    at: end,
    backupId: id,
    file: `${id}.sqlite`,
    durationMs: end - start,
    bytes: 4096,
  },
];
const healthy = () => {
  const t = new BoundedRequestTimeline();
  t.record(5000, 5050, 200, true);
  return t;
};

describe("bounded load and backup observation", () => {
  it("counts full request lifetimes crossing a window, with separate start/end counts and 429/network failures", () => {
    const t = new BoundedRequestTimeline();
    t.record(0, 5000, 200, true);
    t.record(1000, 1100, 429, false);
    t.record(1200, 1300, 0, false);
    t.record(1400, 1500, 503, false);
    t.record(8000, 9000, 200, false);
    expect(t.summarize(1000, 2000)).toMatchObject({
      count: 4,
      writes: 1,
      startedInWindow: 3,
      finishedInWindow: 3,
      rejected: 1,
      errors: 2,
      statusCounts: { "0": 1, "200": 1, "429": 1, "503": 1 },
      p50Ms: 100,
      p95Ms: 5000,
      p99Ms: 5000,
      maxMs: 5000,
    });
  });
  it("pairs exact backup IDs, preserves metadata, and measures overlap and wider context independently", () => {
    const t = healthy();
    t.record(4100, 4200, 200, false);
    const result = analyzeBackupWindows(
      events().map((e) => ({ ...e, at: new Date(Number(e.at)).toISOString() })),
      t,
      options,
    );
    expect(result).toMatchObject({
      passed: true,
      completeBackupsInLoad: 1,
      dropped: 0,
    });
    expect(result.backups[0]).toMatchObject({
      backupId: "backup-a",
      file: "backup-a.sqlite",
      startAt: 5000,
      endAt: 5100,
      durationMs: 100,
      observedDurationMs: 100,
      bytes: 4096,
      entirelyWithinLoad: true,
      passed: true,
      overlapWindow: {
        startAt: 4900,
        endAt: 5200,
        stats: { count: 1, writes: 1 },
      },
      contextWindow: {
        startAt: 4000,
        endAt: 6100,
        stats: { count: 2, writes: 1 },
      },
    });
    const [aStart, aEnd] = events("a"),
      [bStart, bEnd] = events("b", 5050, 5200);
    t.record(5070, 5080, 200, true);
    expect(
      analyzeBackupWindows([aStart, bStart, aEnd, bEnd], t, options)
        .completeBackupsInLoad,
    ).toBe(2);
  });
  it("rejects missing, failed, duplicated, misordered and mismatched backup evidence", () => {
    const [start, end] = events();
    const malformed = [
      [],
      [start],
      [end],
      [end, start],
      [start, start, end],
      [start, end, end],
      [start, { ...end, at: 4900 }],
      [start, { ...end, file: "other.sqlite" }],
      [start, { ...end, backupId: "other" }],
      [start, { ...end, bytes: undefined }],
      [start, { ...end, durationMs: -1 }],
      [start, end, { ...end, event: "backup_failed" }],
      [{ ...start, at: "bad-time" }, end],
    ];
    for (const input of malformed) {
      const result = analyzeBackupWindows(input, healthy(), options);
      expect(result.passed, JSON.stringify(input)).toBe(false);
      expect(result.failures.length).toBeGreaterThan(0);
    }
  });
  it("keeps samples and drop counts bounded, rejects invalid timings, and fails acceptance if samples are lost", () => {
    const t = new BoundedRequestTimeline(2);
    t.record(5000, 5010, 200, true);
    t.record(5020, 5030, 200, false);
    for (let i = 0; i < 10; i++) t.record(5040, 5050, 200, true);
    expect(t.count).toBe(2);
    expect(t.dropped).toBe(10);
    expect(t.summarize(0, 10_000)).toMatchObject({
      count: 2,
      writes: 1,
      dropped: 10,
    });
    expect(analyzeBackupWindows(events(), t, options)).toMatchObject({
      passed: false,
      dropped: 10,
    });
    expect(() => t.record(2, 1, 200, true)).toThrow();
    expect(() => t.record(Number.NaN, 1, 200, true)).toThrow();
    expect(() => t.record(0, 1, -1, true)).toThrow();
    expect(() => new BoundedRequestTimeline(Infinity)).toThrow();
  });
  it("handles a chunk boundary and does not silently overwrite early samples", () => {
    const t = new BoundedRequestTimeline(65_537);
    for (let i = 0; i < 65_537; i++)
      t.record(i, i + 1, 200, i === 0 || i === 65_536);
    t.record(70_000, 70_001, 200, true);
    expect(t.summarize(0, 70_000)).toMatchObject({
      count: 65_537,
      writes: 2,
      dropped: 1,
      maxMs: 1,
    });
  });
  it("fails on errors or 429 specifically during the backup or its wider context", () => {
    for (const [at, status] of [
      [5000, 500],
      [5000, 429],
      [4100, 0],
      [6000, 429],
    ]) {
      const t = healthy();
      t.record(at, at + 10, status, false);
      expect(analyzeBackupWindows(events(), t, options).passed).toBe(false);
    }
  });
  it("does not let overall P95 hide a request stalled across the entire backup window", () => {
    const t = healthy();
    for (let i = 0; i < 1000; i++) t.record(10_000, 10_001, 200, false);
    t.record(2000, 8000, 200, true);
    expect(t.summarize(0, 20_000).p95Ms).toBe(1);
    const result = analyzeBackupWindows(events(), t, options);
    expect(result.passed).toBe(false);
    expect(result.backups[0].overlapWindow.stats).toMatchObject({
      count: 2,
      startedInWindow: 1,
      finishedInWindow: 1,
      p95Ms: 6000,
    });
    expect(result.backups[0].contextWindow.stats.p95Ms).toBe(6000);
    const contextOnly = healthy();
    contextOnly.record(1000, 4500, 200, false);
    const contextResult = analyzeBackupWindows(events(), contextOnly, options);
    expect(contextResult.backups[0].overlapWindow.stats.p95Ms).toBe(50);
    expect(contextResult.backups[0].contextWindow.stats.p95Ms).toBe(3500);
    expect(contextResult.passed).toBe(false);
  });
  it("rejects backup tail latency even when its P95 passes", () => {
    const t = healthy();
    for (let i = 0; i < 97; i++) t.record(5000, 5010, 200, false);
    t.record(2000, 8001, 200, true);
    t.record(2001, 8002, 200, false);
    const result = analyzeBackupWindows(events(), t, options);
    expect(result.backups[0].overlapWindow.stats.p95Ms).toBeLessThan(2000);
    expect(result.backups[0].overlapWindow.stats.p99Ms).toBe(6001);
    expect(result.passed).toBe(false);
    expect(result.failures).toContain("Backup backup-a: overlap window P99 exceeds 5000ms");
    expect(result.failures).toContain("Backup backup-a: context window P99 exceeds 5000ms");
  });
  it("requires full backup and context coverage inside load, plus a write in each measured window", () => {
    expect(
      analyzeBackupWindows(
        events("outside", 21_000, 22_000),
        healthy(),
        options,
      ).passed,
    ).toBe(false);
    const t = new BoundedRequestTimeline();
    t.record(5000, 5050, 200, false);
    expect(analyzeBackupWindows(events(), t, options).passed).toBe(false);
    const edge = new BoundedRequestTimeline();
    edge.record(100, 150, 200, true);
    const result = analyzeBackupWindows(
      events("edge", 100, 200),
      edge,
      options,
    );
    expect(result.backups[0].entirelyWithinLoad).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.failures).toContain(
      "Backup edge: context window is not fully covered by load",
    );
  });
});
