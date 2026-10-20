import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureBackupState,
  automaticBackupDue,
  BACKUP_DUE_AFTER_MS,
  recordBackupSuccess,
  recordBackupFailure,
  recordBackupReplica,
  readBackupStatus,
  setBackupRunning,
} from "../src/backup-state";

let directory: string, database: string, pair: string, sql: DatabaseSync;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "shopmate-backup-state-"));
  database = join(directory, "state.sqlite");
  pair = join(directory, "snapshot.sqlite");
  sql = new DatabaseSync(database);
  ensureBackupState(sql);
  writeFileSync(pair, "snapshot existence probe");
  writeFileSync(pair + ".manifest.json", "manifest existence probe");
});
afterEach(() => {
  vi.unstubAllEnvs();
  sql.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("durable backup scheduling", () => {
  it("reports replica configuration separately from a prior verified replica marker", () => {
    vi.stubEnv("BACKUP_REPLICA_DIR", "");
    const createdAt = new Date().toISOString();
    recordBackupReplica(sql, createdAt, createdAt);
    expect(readBackupStatus(sql)).toMatchObject({
      replicaConfigured: false,
      lastReplicaSnapshotAt: createdAt,
    });
    vi.stubEnv("BACKUP_REPLICA_DIR", "not-returned-private-receiver");
    expect(readBackupStatus(sql).replicaConfigured).toBe(true);
    expect(JSON.stringify(readBackupStatus(sql))).not.toContain(
      "not-returned-private-receiver",
    );
  });

  it("retains the verified snapshot marker across restarts and schedules before 23 hours", () => {
    const now = Date.now();
    expect(automaticBackupDue(sql, now)).toBe(true);
    recordBackupSuccess(sql, pair, new Date(now).toISOString());
    setBackupRunning(sql, true);
    expect(readBackupStatus(sql).running).toBe(true);
    sql.close();
    sql = new DatabaseSync(database);
    ensureBackupState(sql);
    expect(readBackupStatus(sql).running).toBe(false);
    expect(automaticBackupDue(sql, now + BACKUP_DUE_AFTER_MS - 1)).toBe(false);
    expect(automaticBackupDue(sql, now + BACKUP_DUE_AFTER_MS)).toBe(true);
    expect(readBackupStatus(sql).lastSuccessAt).toBe(
      new Date(now).toISOString(),
    );
  });

  it("retries if a pair is missing or the clock moved backwards", () => {
    const now = Date.now();
    recordBackupSuccess(sql, pair, new Date(now).toISOString());
    expect(automaticBackupDue(sql, now - 1)).toBe(true);
    rmSync(pair + ".manifest.json");
    expect(automaticBackupDue(sql, now)).toBe(true);
  });

  it("records only safe failure codes and distinguishes a filesystem replica from offhost proof", () => {
    recordBackupFailure(sql, new Error("password=private-service-secret"));
    expect(readBackupStatus(sql)).toMatchObject({
      lastErrorCode: "BACKUP_WORKER_FAILED",
      lastReplicaAt: null,
    });
    const createdAt = new Date().toISOString();
    recordBackupSuccess(sql, pair, createdAt);
    recordBackupReplica(sql, createdAt, createdAt);
    sql.close();
    sql = new DatabaseSync(database);
    expect(readBackupStatus(sql)).toMatchObject({
      lastErrorCode: null,
      lastReplicaAt: createdAt,
      lastReplicaSnapshotAt: createdAt,
      replicaKind: "filesystem-copy",
      offhostVerified: false,
    });
    expect(JSON.stringify(readBackupStatus(sql))).not.toContain(directory);
    expect(JSON.stringify(readBackupStatus(sql))).not.toContain(
      "private-service-secret",
    );
  });
});
