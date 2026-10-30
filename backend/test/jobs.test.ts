import { expect, it } from "vitest";
import { openDatabase } from "../src/database";
import { ensureRecurringJobs, runDueJobs } from "../src/jobs";
import { enqueue } from "../src/runtime";

it.each([
  ["unsupported", "{}", "UNSUPPORTED_JOB_KIND"],
  ["notification", "{", "INVALID_NOTIFICATION_PAYLOAD"],
  ["notification", "null", "INVALID_NOTIFICATION_PAYLOAD"],
])("does not retry a permanent %s error", (kind, payload, code) => {
  const sql = openDatabase(":memory:");
  try {
    ensureRecurringJobs(sql);
    enqueue(sql, kind, {}, "invalid");
    sql
      .prepare("UPDATE job_queue SET payload=? WHERE id='invalid'")
      .run(payload);
    const now = Date.now();
    runDueJobs(sql, { now });
    runDueJobs(sql, { now: now + 60000 });
    expect(
      sql
        .prepare(
          "SELECT status,attempts,last_error FROM job_queue WHERE id='invalid'",
        )
        .get(),
    ).toEqual({ status: "failed", attempts: 1, last_error: code });
  } finally {
    sql.close();
  }
});

it("retries a database execution failure and delivers once after it recovers", () => {
  const sql = openDatabase(":memory:");
  try {
    ensureRecurringJobs(sql);
    enqueue(
      sql,
      "notification",
      { userId: "u1", text: "已更新" },
      "recoverable",
    );
    sql.exec(
      "CREATE TRIGGER block_notification BEFORE INSERT ON biz_notifications BEGIN SELECT RAISE(ABORT,'temporary failure'); END",
    );
    const now = Date.now();
    runDueJobs(sql, { now });
    expect(
      sql
        .prepare(
          "SELECT status,attempts,last_error FROM job_queue WHERE id='recoverable'",
        )
        .get(),
    ).toEqual({
      status: "pending",
      attempts: 1,
      last_error: "JOB_EXECUTION_FAILED",
    });
    sql.exec("DROP TRIGGER block_notification");
    runDueJobs(sql, { now: now + 2000 });
    expect(
      sql
        .prepare("SELECT status,attempts FROM job_queue WHERE id='recoverable'")
        .get(),
    ).toEqual({ status: "done", attempts: 2 });
    expect(
      sql.prepare("SELECT count(*) n FROM biz_notifications").get()?.n,
    ).toBe(1);
  } finally {
    sql.close();
  }
});
