import { transaction } from "./database";
import { HttpError } from "./errors";
import { admin, context } from "./repository";
import { demand } from "./permissions";
import { audit } from "./runtime";

/** Recovery changes only scheduling; the original payload and deterministic job id stay intact. */
export const maintenanceCommands = {
  async retryJob(id: string, expectedRetryVersion: number) {
    const actor = admin(),
      store = context.getStore()!;
    demand(actor, "settings");
    const { sql, command } = store;
    if (!command)
      throw new HttpError(
        400,
        "任务恢复必须携带请求标识",
        "REQUEST_ID_REQUIRED",
      );
    return transaction(sql, () => {
      // Check again within the write transaction, including concurrent lost-response retries.
      const prior = sql
        .prepare(
          "SELECT fingerprint,result FROM command_results WHERE actor_id=? AND method=? AND request_id=?",
        )
        .get(actor.id, command.method, command.requestId);
      if (prior) {
        if (prior.fingerprint !== command.fingerprint)
          throw new HttpError(
            409,
            "请求标识已用于其他内容",
            "IDEMPOTENCY_CONFLICT",
          );
        return JSON.parse(String(prior.result)) as {
          id: string;
          retryVersion: number;
          status: "pending";
        };
      }
      const job = sql
        .prepare(
          "SELECT kind,status,payload,attempts,last_error,retry_version FROM job_queue WHERE id=?",
        )
        .get(id);
      if (!job) throw new HttpError(404, "任务不存在", "JOB_NOT_FOUND");
      if (job.status !== "failed" || job.retry_version !== expectedRetryVersion)
        throw new HttpError(
          409,
          "任务状态已变化，请刷新后核对",
          "JOB_STATE_CONFLICT",
        );
      let valid = false;
      try {
        const payload = JSON.parse(String(job.payload));
        if (payload && typeof payload === "object" && !Array.isArray(payload)) {
          if (job.kind === "expiry")
            valid =
              id === "expiry-recurring" && Object.keys(payload).length === 0;
          if (job.kind === "notification") {
            valid =
              typeof payload.userId === "string" &&
              !!payload.userId.trim() &&
              typeof payload.text === "string" &&
              !!payload.text.trim() &&
              payload.text.length <= 1000 &&
              (payload.orderId === undefined ||
                typeof payload.orderId === "string") &&
              Object.keys(payload).every((key) =>
                ["userId", "text", "orderId"].includes(key),
              ) &&
              !!sql
                .prepare("SELECT 1 FROM accounts WHERE id=? AND role='user'")
                .get(payload.userId);
            if (valid && payload.orderId !== undefined)
              valid = !!sql
                .prepare("SELECT 1 FROM biz_orders WHERE key=? AND user_id=?")
                .get(payload.orderId, payload.userId);
          }
        }
      } catch {
        /* Reject malformed persisted data; never expose its content. */
      }
      if (!valid)
        throw new HttpError(
          409,
          "任务类型或原始内容无效，请先排查原因",
          "JOB_NOT_RETRYABLE",
        );
      const retryVersion = expectedRetryVersion + 1;
      sql
        .prepare(
          "UPDATE job_queue SET status='pending',attempts=0,last_error=NULL,run_after=?,retry_version=? WHERE id=?",
        )
        .run(Date.now(), retryVersion, id);
      const result = { id, retryVersion, status: "pending" as const };
      sql
        .prepare("INSERT INTO command_results VALUES(?,?,?,?,?,?)")
        .run(
          actor.id,
          command.method,
          command.requestId,
          command.fingerprint,
          JSON.stringify(result),
          new Date().toISOString(),
        );
      // Store only bounded, fixed metadata, never a payload or arbitrary historical exception.
      audit(
        sql,
        actor.id,
        command.method,
        command.requestId,
        JSON.stringify({
          status: "rescheduled",
          previousAttempts: job.attempts,
          previousError: [
            "INVALID_NOTIFICATION_PAYLOAD",
            "UNSUPPORTED_JOB_KIND",
            "JOB_EXECUTION_FAILED",
          ].includes(String(job.last_error))
            ? job.last_error
            : "UNKNOWN",
          retryVersion,
        }),
        id,
      );
      return result;
    });
  },
};
