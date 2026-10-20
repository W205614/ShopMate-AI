import { expect, it } from "vitest";
import { AlertTracker, evaluateProbe, type Probe } from "../scripts/monitor";

const now = Date.now();
const healthy: Probe = {
  health: true,
  latencyMs: 20,
  containers: true,
  diskFreeRatio: 0.3,
  diagnostics: {
    jobs: { failed: 0, oldestWaitingMs: 0 },
    backup: {
      enabled: true,
      replicaConfigured: false,
      lastReplicaSnapshotAt: null,
      lastSuccessAt: new Date(now - 3600000).toISOString(),
      lastFailureAt: null,
      lastErrorCode: null,
    },
  },
};
it("detects operational failures with fixed redacted codes and validates backup recovery", () => {
  expect(evaluateProbe(healthy, now)).toEqual([]);
  const bad = structuredClone(healthy);
  bad.diskFreeRatio = 0.19;
  bad.diagnostics!.jobs = { failed: 1, oldestWaitingMs: 300001 };
  bad.diagnostics!.backup.lastSuccessAt = new Date(
    now - 24 * 3600000,
  ).toISOString();
  bad.diagnostics!.backup.lastFailureAt = new Date(now).toISOString();
  bad.diagnostics!.backup.lastErrorCode = "BACKUP_REPLICA_FAILED";
  expect(evaluateProbe(bad, now)).toEqual([
    "BACKUP_FAILED",
    "BACKUP_STALE",
    "DISK_LOW",
    "JOB_FAILED",
    "JOB_STALLED",
  ]);
  bad.diagnostics!.backup.lastSuccessAt = new Date(now).toISOString();
  bad.diagnostics!.backup.lastFailureAt = new Date(now - 1).toISOString();
  bad.diagnostics!.backup.lastErrorCode = null;
  expect(evaluateProbe(bad, now)).not.toContain("BACKUP_FAILED");
  expect(evaluateProbe({ ...healthy, diagnostics: undefined }, now)).toContain(
    "DIAGNOSTICS_UNAVAILABLE",
  );
});
it("detects configured replica gaps independently of a fresh local success or cleared error", () => {
  const probe = structuredClone(healthy),
    backup = probe.diagnostics!.backup;
  backup.replicaConfigured = true;
  backup.lastSuccessAt = new Date(now).toISOString();
  expect(evaluateProbe(probe, now)).toEqual(["REPLICA_STALE"]);
  for (const snapshot of [
    "invalid",
    new Date(now + 1).toISOString(),
    new Date(now - 23 * 3600000 - 1).toISOString(),
  ]) {
    backup.lastReplicaSnapshotAt = snapshot;
    expect(evaluateProbe(probe, now)).toContain("REPLICA_STALE");
  }
  backup.lastReplicaSnapshotAt = new Date(now - 23 * 3600000).toISOString();
  expect(evaluateProbe(probe, now)).toEqual([]);
  backup.replicaConfigured = false;
  backup.lastReplicaSnapshotAt = null;
  expect(evaluateProbe(probe, now)).toEqual([]);
});
it("requires three consecutive failures per issue, suppresses repeated alerts and resets in maintenance", () => {
  const tracker = new AlertTracker();
  expect(tracker.update(["HEALTH_FAILED"])).toBeNull();
  expect(tracker.update(["DISK_LOW"])).toBeNull();
  expect(tracker.update(["HEALTH_FAILED"])).toBeNull();
  expect(tracker.update(["HEALTH_FAILED"])).toBeNull();
  expect(tracker.update(["HEALTH_FAILED"])).toEqual({
    event: "monitor_alert",
    issues: ["HEALTH_FAILED"],
  });
  expect(tracker.update(["HEALTH_FAILED"])).toBeNull();
  expect(tracker.update([])).toEqual({
    event: "monitor_recovered",
    issues: [],
  });
  tracker.update(["DISK_LOW"]);
  tracker.update(["DISK_LOW"]);
  expect(tracker.update(["DISK_LOW"], true)).toBeNull();
  expect(tracker.update(["DISK_LOW"])).toBeNull();
  expect(tracker.update(["DISK_LOW"])).toBeNull();
  expect(tracker.update(["DISK_LOW"])).toMatchObject({
    event: "monitor_alert",
  });
});
