import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { transaction } from "./database";
import { insertStoredRecord } from "./storage";
import { expirePendingOrders } from "./commerce";
import { ensureRuntimeSchema } from "./runtime";

interface Job {
  id: string;
  kind: string;
  payload: string;
  attempts: number;
  status: string;
  run_after: number;
}
const MAX_ATTEMPTS = 5;

/** Idempotent scheduling survives restart; one bounded batch keeps the event loop available. */
export function ensureRecurringJobs(sql: DatabaseSync) {
  ensureRuntimeSchema(sql);
  sql
    .prepare(
      `INSERT OR IGNORE INTO job_queue(id,kind,payload,status,attempts,run_after,created_at)
    VALUES('expiry-recurring','expiry','{}','pending',0,?,?)`,
    )
    .run(Date.now(), new Date().toISOString());
}

export function runDueJobs(
  sql: DatabaseSync,
  options: { now?: number; batchSize?: number } = {},
) {
  ensureRecurringJobs(sql);
  const at = options.now ?? Date.now(),
    limit = Math.min(20, Math.max(1, options.batchSize ?? 10));
  const due = sql
    .prepare(
      "SELECT * FROM job_queue WHERE status='pending' AND run_after<=? ORDER BY run_after,id LIMIT ?",
    )
    .all(at, limit) as unknown as Job[];
  let completed = 0,
    failed = 0;
  for (const job of due) {
    try {
      if (job.kind === "expiry") {
        // Expiry owns its own transaction. Re-execution after a crash is harmless.
        expirePendingOrders(sql);
        sql.prepare("DELETE FROM sessions WHERE expires_at<=?").run(at);
        sql.prepare("DELETE FROM rate_limits WHERE reset_at<=?").run(at);
        sql
          .prepare(
            "UPDATE job_queue SET attempts=0,run_after=?,last_error=NULL WHERE id=? AND status='pending'",
          )
          .run(at + 60000, job.id);
      } else if (job.kind === "notification") {
        transaction(sql, () => {
          const current = sql
            .prepare("SELECT status FROM job_queue WHERE id=?")
            .get(job.id) as { status: string } | undefined;
          if (current?.status !== "pending") return;
          const payload = JSON.parse(job.payload) as {
            userId?: unknown;
            orderId?: unknown;
            text?: unknown;
          };
          if (
            typeof payload.userId !== "string" ||
            !payload.userId ||
            typeof payload.text !== "string" ||
            !payload.text.trim() ||
            payload.text.length > 1000 ||
            (payload.orderId !== undefined &&
              typeof payload.orderId !== "string")
          )
            throw new Error("INVALID_NOTIFICATION_PAYLOAD");
          const id = `notification-${createHash("sha256").update(job.id).digest("hex")}`;
          insertStoredRecord(
            sql,
            "notifications",
            {
              id,
              userId: payload.userId,
              ...(payload.orderId
                ? { orderId: payload.orderId as string }
                : {}),
              text: payload.text,
              read: false,
              createdAt: new Date(at).toISOString(),
            },
            true,
          );
          sql
            .prepare(
              "UPDATE job_queue SET status='done',attempts=attempts+1,last_error=NULL WHERE id=?",
            )
            .run(job.id);
        });
      } else throw new Error("UNSUPPORTED_JOB_KIND");
      completed++;
    } catch (error) {
      const attempts = job.attempts + 1;
      // Store a fixed code; exception messages can contain private payloads or SQL fragments.
      const code =
        error instanceof Error &&
        ["INVALID_NOTIFICATION_PAYLOAD", "UNSUPPORTED_JOB_KIND"].includes(
          error.message,
        )
          ? error.message
          : "JOB_EXECUTION_FAILED";
      sql
        .prepare(
          "UPDATE job_queue SET attempts=?,status=?,run_after=?,last_error=? WHERE id=? AND status='pending'",
        )
        .run(
          attempts,
          attempts >= MAX_ATTEMPTS ? "failed" : "pending",
          at + Math.min(3600000, 1000 * 2 ** attempts),
          code,
          job.id,
        );
      failed++;
    }
  }
  return { processed: due.length, completed, failed };
}
