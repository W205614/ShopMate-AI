import type { Express, RequestHandler } from "express";
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { findSession } from "./auth";
import { demand } from "./permissions";
import { readBackupStatus } from "./backup-state";

/** Counters are process-local and explicitly reset on restart. No request bodies are retained. */
export function createRequestObserver(logRequests = false, limit = 64) {
  const counters = { active: 0, completed: 0, overloaded: 0, databaseBusy: 0 };
  const middleware: RequestHandler = (req, res, next) => {
    const incoming = req.get("X-Request-ID"),
      requestId =
        incoming && /^[a-zA-Z0-9_-]{1,128}$/.test(incoming)
          ? incoming
          : randomUUID();
    res.locals.requestId = requestId;
    res.setHeader("X-Request-ID", requestId);
    const admitted = counters.active < limit,
      start = performance.now();
    let finished = false;
    if (admitted) counters.active++;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (admitted) counters.active--;
      counters.completed++;
      if (logRequests)
        console.log(
          JSON.stringify({
            level: "info",
            event: "http",
            requestId,
            method: req.method,
            path: req.path,
            status: res.statusCode,
            durationMs: Math.round(performance.now() - start),
          }),
        );
    };
    res.once("finish", finish);
    res.once("close", finish);
    if (!admitted) {
      counters.overloaded++;
      return void res.status(429).set("Retry-After", "1").json({
        message: "服务繁忙，请稍后重试",
        code: "OVERLOADED",
        requestId,
      });
    }
    next();
  };
  return { counters, middleware };
}

type Totals = { rows: number; payloadBytes: number };
function totals(sql: DatabaseSync, table: string, payload: string): Totals {
  return sql
    .prepare(
      `SELECT count(*) rows, coalesce(sum(${payload}),0) payloadBytes FROM ${table}`,
    )
    .get() as Totals;
}

export function registerDiagnostics(
  app: Express,
  sql: DatabaseSync,
  requests: ReturnType<typeof createRequestObserver>,
) {
  const startedAt = Date.now();
  sql.exec(`CREATE INDEX IF NOT EXISTS support_runs_status_diagnostics ON support_runs(status,created_at);
    CREATE INDEX IF NOT EXISTS ai_documents_status_diagnostics ON ai_documents(status,updated_at);`);
  let lastSample:
    { at: number; collections: Record<string, Totals> } | undefined;
  let cached: unknown;
  app.get("/api/admin/diagnostics", (req, res) => {
    demand(findSession(sql, req, "admin"), "settings");
    const now = Date.now();
    // Large payload aggregates are cached; no business payload leaves this endpoint.
    if (!lastSample || now - lastSample.at >= 60000) {
      const collections = {
        commandResults: totals(
          sql,
          "command_results",
          "length(CAST(result AS BLOB))",
        ),
        jobs: totals(sql, "job_queue", "length(CAST(payload AS BLOB))"),
        conversations: totals(
          sql,
          "biz_conversations",
          "length(CAST(data AS BLOB))",
        ),
        knowledgeVectors: totals(sql, "ai_knowledge_chunks", "length(vector)"),
        quotes: totals(
          sql,
          "biz_checkout_quotes",
          "length(CAST(data AS BLOB))",
        ),
      };
      cached = {
        sampledAt: new Date(now).toISOString(),
        intervalMs: lastSample ? now - lastSample.at : null,
        collections: Object.fromEntries(
          Object.entries(collections).map(([name, total]) => [
            name,
            {
              ...total,
              growthRows: lastSample
                ? total.rows - lastSample.collections[name]!.rows
                : null,
              growthPayloadBytes: lastSample
                ? total.payloadBytes -
                  lastSample.collections[name]!.payloadBytes
                : null,
            },
          ]),
        ),
        // Payload bytes measure retained application content, not SQLite file allocation.
        bytesMeasure: "payload-only",
      };
      lastSample = { at: now, collections };
    }
    const jobs = sql
      .prepare(
        `SELECT
      (SELECT count(*) FROM job_queue WHERE status='pending') pending,
      (SELECT count(*) FROM job_queue WHERE status='failed') failed,
      (SELECT min(run_after) FROM job_queue WHERE status='pending' AND run_after<=?) oldestDueAt
      `,
      )
      .get(now) as {
      pending: number;
      failed: number;
      oldestDueAt: number | null;
    };
    const support = sql
      .prepare(
        "SELECT status,count(*) count FROM support_runs WHERE status IN ('queued','running','failed') GROUP BY status",
      )
      .all();
    const documents = sql
      .prepare(
        "SELECT status,count(*) count FROM ai_documents WHERE status IN ('queued','extracting','indexing','failed') GROUP BY status",
      )
      .all();
    const version = sql
      .prepare(
        "SELECT schema_version schemaVersion,version businessVersion,revision FROM storage_meta WHERE id=1",
      )
      .get();
    res.json({
      at: new Date(now).toISOString(),
      startedAt: new Date(startedAt).toISOString(),
      requests: { ...requests.counters, scope: "process-lifetime" },
      jobs: {
        pending: jobs.pending ?? 0,
        failed: jobs.failed ?? 0,
        oldestWaitingMs:
          jobs.oldestDueAt === null ? 0 : Math.max(0, now - jobs.oldestDueAt),
      },
      ai: { enabled: process.env.AI_ENABLED === "true", support, documents },
      backup: readBackupStatus(sql),
      storage: cached,
      version: {
        ...version,
        revisionRef: (process.env.VCS_REF ?? "local").slice(0, 80),
        node: process.version,
      },
    });
  });
}
