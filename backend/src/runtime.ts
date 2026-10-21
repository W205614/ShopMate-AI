import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { HttpError } from "./errors";

export function ensureRuntimeSchema(sql: DatabaseSync) {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS staff_access(account_id TEXT PRIMARY KEY REFERENCES accounts(id), staff_role TEXT NOT NULL CHECK(staff_role IN ('owner','operations','warehouse','support','finance')),active INTEGER NOT NULL CHECK(active IN (0,1)));
    CREATE TABLE IF NOT EXISTS command_results(actor_id TEXT NOT NULL,method TEXT NOT NULL,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(actor_id,method,request_id));
    CREATE TABLE IF NOT EXISTS operation_audit(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,action TEXT NOT NULL,request_id TEXT NOT NULL,object_id TEXT,result TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS operation_audit_time ON operation_audit(created_at DESC);
    CREATE TABLE IF NOT EXISTS job_queue(id TEXT PRIMARY KEY,kind TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('pending','done','failed')),attempts INTEGER NOT NULL DEFAULT 0,run_after INTEGER NOT NULL,last_error TEXT,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS job_queue_due ON job_queue(status,run_after);
  `);
  // Additive migration preserves old jobs and their retry evidence.
  if (
    !sql
      .prepare("PRAGMA table_info(job_queue)")
      .all()
      .some((column) => column.name === "retry_version")
  )
    sql.exec(
      "ALTER TABLE job_queue ADD COLUMN retry_version INTEGER NOT NULL DEFAULT 0",
    );
  sql.exec(
    `CREATE INDEX IF NOT EXISTS job_queue_status_page ON job_queue(status,created_at DESC,id DESC);
     CREATE INDEX IF NOT EXISTS job_queue_time_page ON job_queue(created_at DESC,id DESC)`,
  );
}
export function audit(
  sql: DatabaseSync,
  actorId: string,
  action: string,
  requestId: string,
  result: string,
  objectId?: string,
) {
  sql
    .prepare("INSERT INTO operation_audit VALUES (?,?,?,?,?,?,?)")
    .run(
      randomUUID(),
      actorId,
      action,
      requestId,
      objectId ?? null,
      result,
      new Date().toISOString(),
    );
}
export function enqueue(
  sql: DatabaseSync,
  kind: string,
  payload: unknown,
  key: string = randomUUID(),
) {
  sql
    .prepare(
      "INSERT OR IGNORE INTO job_queue(id,kind,payload,status,run_after,created_at) VALUES (?,?,?,'pending',?,?)",
    )
    .run(
      key,
      kind,
      JSON.stringify(payload),
      Date.now(),
      new Date().toISOString(),
    );
}
export class BoundedQueue {
  private active = 0;
  private waiters: (() => void)[] = [];
  constructor(
    private concurrency = 2,
    private capacity = 8,
  ) {}
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) {
      if (this.waiters.length >= this.capacity)
        throw new HttpError(429, "服务繁忙，请稍后使用原请求重试");
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    } else this.active++;
    try {
      return await work();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    }
  }
  get stats() {
    return { active: this.active, waiting: this.waiters.length };
  }
}
