import type { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";

export const BACKUP_MAX_INTERVAL_MS = 23 * 60 * 60 * 1000;
// Allow one polling minute and the worker's two-minute timeout before the 23h gate.
export const BACKUP_DUE_AFTER_MS = BACKUP_MAX_INTERVAL_MS - 3 * 60000;
const running = new WeakSet<DatabaseSync>();

interface BackupState {
  last_success_at: string | null;
  last_path: string | null;
  last_failure_at: string | null;
  last_error_code: string | null;
  last_replica_at: string | null;
  last_replica_snapshot_at: string | null;
}

export function ensureBackupState(sql: DatabaseSync) {
  sql.exec(`CREATE TABLE IF NOT EXISTS backup_runtime (
    id INTEGER PRIMARY KEY CHECK(id=1),
    last_success_at TEXT, last_path TEXT, last_failure_at TEXT,
    last_error_code TEXT, last_replica_at TEXT, last_replica_snapshot_at TEXT
  ); INSERT OR IGNORE INTO backup_runtime(id) VALUES(1);`);
}

function state(sql: DatabaseSync) {
  if (
    !sql
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='backup_runtime'",
      )
      .get()
  )
    return undefined;
  return sql.prepare("SELECT * FROM backup_runtime WHERE id=1").get() as
    BackupState | undefined;
}

export function readBackupStatus(sql: DatabaseSync) {
  const current = state(sql);
  return {
    enabled: Boolean(process.env.BACKUP_DIR),
    running: running.has(sql),
    lastSuccessAt: current?.last_success_at ?? null,
    lastFailureAt: current?.last_failure_at ?? null,
    lastErrorCode: current?.last_error_code ?? null,
    lastReplicaAt: current?.last_replica_at ?? null,
    lastReplicaSnapshotAt: current?.last_replica_snapshot_at ?? null,
    replicaKind: current?.last_replica_at ? ("filesystem-copy" as const) : null,
    offhostVerified: false,
  };
}

export function automaticBackupDue(sql: DatabaseSync, now = Date.now()) {
  const current = state(sql),
    last = Date.parse(current?.last_success_at ?? "");
  return (
    !Number.isFinite(last) ||
    last > now ||
    now - last >= BACKUP_DUE_AFTER_MS ||
    !current?.last_path ||
    !existsSync(current.last_path) ||
    !existsSync(current.last_path + ".manifest.json")
  );
}

export function setBackupRunning(sql: DatabaseSync, value: boolean) {
  if (value) running.add(sql);
  else running.delete(sql);
}

export function recordBackupSuccess(
  sql: DatabaseSync,
  path: string,
  createdAt: string,
) {
  if (!Number.isFinite(Date.parse(createdAt)))
    throw new Error("BACKUP_WORKER_PROTOCOL");
  sql
    .prepare(
      "UPDATE backup_runtime SET last_success_at=?,last_path=?,last_error_code=NULL WHERE id=1",
    )
    .run(createdAt, path);
}

export function recordBackupFailure(sql: DatabaseSync, error: unknown) {
  const message = error instanceof Error ? error.message : "";
  const code = /^BACKUP_[A-Z_]+$/.test(message)
    ? message
    : "BACKUP_WORKER_FAILED";
  sql
    .prepare(
      "UPDATE backup_runtime SET last_failure_at=?,last_error_code=? WHERE id=1",
    )
    .run(new Date().toISOString(), code);
}

export function recordBackupReplica(
  sql: DatabaseSync,
  copiedAt: string,
  snapshotAt: string,
) {
  sql
    .prepare(
      "UPDATE backup_runtime SET last_replica_at=?,last_replica_snapshot_at=? WHERE id=1",
    )
    .run(copiedAt, snapshotAt);
}
