import type { Express } from "express";
import type { DatabaseSync } from "node:sqlite";
import {
  ensureNotificationSchema,
  registerNotificationRoutes,
  runNotificationJobs,
  validateNotificationConfig,
} from "./notifications";
import {
  ensureLogisticsSchema,
  registerLogisticsRoutes,
  runLogisticsJobs,
  validateLogisticsConfig,
} from "./logistics";
import {
  ensureAssetSchema,
  registerAssetRoutes,
  validateAssetConfig,
  s3Config,
} from "./assets";
import { findSession } from "../auth";
import { demand } from "../permissions";
export {
  enqueueNotification,
  sendVerification,
  verificationChannels,
} from "./notifications";
export { enqueueShipment, registerLogisticsWebhooks } from "./logistics";
export { validateAssetReferences } from "./assets";

export function ensureExternalSchema(sql: DatabaseSync) {
  ensureNotificationSchema(sql);
  ensureLogisticsSchema(sql);
  ensureAssetSchema(sql);
}

export function exportExternalAccountData(
  sql: DatabaseSync,
  accountId: string,
) {
  return {
    deliveries: sql
      .prepare(
        "SELECT id,order_id orderId,channel,event,status,created_at createdAt,updated_at updatedAt FROM external_notifications WHERE account_id=? ORDER BY created_at,id",
      )
      .all(accountId),
    shipments: sql
      .prepare(
        "SELECT s.id,s.order_id orderId,s.kind,s.carrier,s.tracking,s.trace,s.updated_at updatedAt FROM external_shipments s JOIN biz_orders o ON o.key=s.order_id WHERE o.user_id=? ORDER BY s.updated_at,s.id",
      )
      .all(accountId)
      .map((row) => ({ ...row, trace: JSON.parse(String(row.trace)) })),
  };
}

export function anonymizeExternalAccount(sql: DatabaseSync, accountId: string) {
  sql
    .prepare(
      "UPDATE external_notifications SET payload='',status=CASE WHEN status IN ('pending','sending') THEN 'failed' ELSE status END,last_error=CASE WHEN status IN ('pending','sending') THEN 'ACCOUNT_CLOSED' ELSE last_error END,updated_at=? WHERE account_id=?",
    )
    .run(Date.now(), accountId);
  sql
    .prepare(
      "DELETE FROM external_logistics_requests WHERE shipment_id IN (SELECT s.id FROM external_shipments s JOIN biz_orders o ON o.key=s.order_id WHERE o.user_id=?)",
    )
    .run(accountId);
  sql
    .prepare(
      "UPDATE external_shipments SET carrier='',tracking='closed-'||id,trace='{}',subscription_status='disabled',last_error='ACCOUNT_CLOSED' WHERE order_id IN (SELECT key FROM biz_orders WHERE user_id=?)",
    )
    .run(accountId);
}
export function validateExternalConfig() {
  validateNotificationConfig();
  validateLogisticsConfig();
  validateAssetConfig();
  if (process.env.BACKUP_S3_ENABLED === "true") {
    s3Config();
    if (!process.env.BACKUP_S3_BUCKET && !process.env.S3_BUCKET)
      throw new Error(
        "BACKUP_S3_BUCKET or S3_BUCKET is required when remote backup is enabled",
      );
  }
}
export async function runExternalJobs(sql: DatabaseSync) {
  await Promise.all([runNotificationJobs(sql), runLogisticsJobs(sql)]);
}
export function registerExternalRoutes(app: Express, sql: DatabaseSync) {
  registerNotificationRoutes(app, sql);
  registerLogisticsRoutes(app, sql);
  registerAssetRoutes(app, sql);
  app.get("/api/admin/integrations/external", (req, res) => {
    demand(findSession(sql, req, "admin"), "settings");
    const count = (table: string, status: string) =>
      Number(
        sql
          .prepare(`SELECT count(*) n FROM ${table} WHERE status=?`)
          .get(status)?.n ?? 0,
      );
    res.json({
      notifications: {
        pending: count("external_notifications", "pending"),
        failed: count("external_notifications", "failed"),
        unknown: count("external_notifications", "unknown"),
      },
      logistics: sql
        .prepare(
          "SELECT coalesce(sum(subscription_status='pending'),0) pending,coalesce(sum(subscription_status='failed'),0) failed FROM external_shipments",
        )
        .get(),
      assets: sql
        .prepare(
          "SELECT count(*) count,coalesce(sum(bytes),0) bytes FROM external_assets WHERE status='ready'",
        )
        .get(),
    });
  });
}
