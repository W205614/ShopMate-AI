import type { Express, RequestHandler } from "express";
import type { DatabaseSync } from "node:sqlite";
import { timingSafeEqual } from "node:crypto";
import { Registry, Gauge, Counter, Histogram } from "@prometheus-io/client";
import { findSession, HttpError } from "../auth";
import { permits } from "../permissions";
import { readBackupStatus } from "../backup/backup-state";
import { productionConfig } from "./config";
import { paymentCounts, type PaymentService } from "./payments";

export function registerProductionRoutes(
  app: Express,
  sql: DatabaseSync,
  service: PaymentService,
) {
  const config = productionConfig();
  app.get("/api/production/config", (_req, res) =>
    res.json({
      mode: config.mode,
      paymentChannels: config.paymentChannels,
      emailEnabled: config.emailEnabled,
      smsEnabled: config.smsEnabled,
    }),
  );
  app.get("/api/admin/production/status", (req, res) => {
    const session = findSession(sql, req, "admin");
    if (!session) throw new HttpError(401, "请先登录管理账号");
    if (
      !["settings", "finance", "warehouse"].some((permission) =>
        permits(session, permission),
      )
    )
      throw new HttpError(403, "当前员工没有此操作权限");
    res.json({
      mode: config.mode,
      paymentChannels: config.paymentChannels,
      integrations: {
        payments: Object.keys(service.options.gateways),
        notifications: { email: config.emailEnabled, sms: config.smsEnabled },
        storage: process.env.ASSET_STORAGE ?? "local",
        logistics: process.env.KUAIDI100_ENABLED === "true",
      },
      counts: paymentCounts(sql),
      externalAcceptance: "not_verified",
    });
  });
}

export function productionObserver(sql: DatabaseSync) {
  const registry = new Registry();
  const completed = new Counter({
    name: "shopmate_http_requests_total",
    help: "HTTP requests completed",
    labelNames: ["method", "route", "status"],
    registers: [registry],
  });
  const duration = new Histogram({
    name: "shopmate_http_duration_seconds",
    help: "HTTP response duration",
    labelNames: ["method", "route"],
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 15],
    registers: [registry],
  });
  const gauge = new Gauge({
    name: "shopmate_production_state",
    help: "Production lifecycle counts",
    labelNames: ["kind"],
    registers: [registry],
  });
  const middleware: RequestHandler = (req, res, next) => {
    const start = performance.now();
    res.once("finish", () => {
      const route =
        typeof req.route?.path === "string" ? req.route.path : "unmatched";
      const method = [
        "GET",
        "POST",
        "PUT",
        "DELETE",
        "PATCH",
        "HEAD",
        "OPTIONS",
      ].includes(req.method)
        ? req.method
        : "OTHER";
      completed.inc({ method, route, status: String(res.statusCode) });
      duration.observe({ method, route }, (performance.now() - start) / 1000);
    });
    next();
  };
  const config = productionConfig();
  const authenticate: RequestHandler = (req, res, next) => {
    const expected = Buffer.from(config.monitoringToken ?? ""),
      provided = Buffer.from(
        req.get("Authorization")?.replace(/^Bearer /, "") ?? "",
      );
    if (
      !expected.length ||
      expected.length !== provided.length ||
      !timingSafeEqual(expected, provided)
    )
      return void res.sendStatus(401);
    next();
  };
  const snapshot = () => {
    const jobs = sql
      .prepare(
        "SELECT sum(status='pending') pending,sum(status='failed') failed,min(CASE WHEN status='pending' THEN run_after END) oldest FROM job_queue",
      )
      .get()!;
    const notifications = sql
      .prepare(
        "SELECT sum(status='failed') failed,sum(status='unknown') unknown FROM external_notifications",
      )
      .get()!;
    return {
      at: new Date().toISOString(),
      jobs: {
        pending: Number(jobs.pending ?? 0),
        failed: Number(jobs.failed ?? 0),
        oldestWaitingMs:
          jobs.oldest === null
            ? 0
            : Math.max(0, Date.now() - Number(jobs.oldest)),
      },
      production: {
        ...paymentCounts(sql),
        notificationsFailed: Number(notifications.failed ?? 0),
        notificationsUnknown: Number(notifications.unknown ?? 0),
      },
      backup: readBackupStatus(sql),
    };
  };
  return {
    middleware,
    register(app: Express) {
      app.get("/api/internal/diagnostics", authenticate, (_req, res) =>
        res.json(snapshot()),
      );
      app.get("/api/internal/metrics", authenticate, async (_req, res) => {
        const state = snapshot();
        for (const [kind, value] of Object.entries(state.production))
          gauge.set({ kind }, value);
        gauge.set({ kind: "jobsPending" }, state.jobs.pending);
        gauge.set({ kind: "jobsFailed" }, state.jobs.failed);
        gauge.set(
          { kind: "jobsOldestWaitingSeconds" },
          state.jobs.oldestWaitingMs / 1000,
        );
        gauge.set({ kind: "backupEnabled" }, Number(state.backup.enabled));
        gauge.set(
          { kind: "backupFailed" },
          Number(Boolean(state.backup.lastErrorCode)),
        );
        gauge.set(
          { kind: "backupLastSuccessTimestamp" },
          state.backup.lastSuccessAt
            ? Date.parse(state.backup.lastSuccessAt) / 1000
            : 0,
        );
        gauge.set(
          { kind: "remoteBackupEnabled" },
          Number(state.backup.remoteConfigured),
        );
        gauge.set(
          { kind: "remoteBackupLastSnapshotTimestamp" },
          state.backup.lastRemoteSnapshotAt
            ? Date.parse(String(state.backup.lastRemoteSnapshotAt)) / 1000
            : 0,
        );
        res.type(registry.contentType).send(await registry.metrics());
      });
    },
  };
}
