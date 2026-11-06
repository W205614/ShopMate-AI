import { test as base, expect } from "@playwright/test";
import {
  openDatabase,
  transaction,
  writeDatabase,
} from "../../backend/src/database";
import { randomBytes, scryptSync } from "node:crypto";
import { resolve } from "node:path";
import { createSeed } from "../../shared/domain/seed";
import { ensureAccountSchema } from "../../backend/src/production/accounts";

export const TEST_USER_PASSWORD = "TestUser123!";
export const TEST_ADMIN_PASSWORD =
  process.env.E2E_ADMIN_PASSWORD ?? "TestAdmin123!";
export const test = base.extend<{ isolatedDatabase: void }>({
  isolatedDatabase: [
    async ({ baseURL: _baseURL }, use) => {
      // Local full-suite fixtures only. An external deployment is never reset by tests.
      if (!process.env.PLAYWRIGHT_BASE_URL) {
        const sql = openDatabase(resolve("../backend/.e2e/shopmate.sqlite"));
        const salt = randomBytes(16).toString("hex");
        const hash = (password: string) =>
          `scrypt$${salt}$${scryptSync(password, salt, 64, { N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 }).toString("hex")}`;
        const userHash = hash(TEST_USER_PASSWORD),
          adminHash = hash(TEST_ADMIN_PASSWORD);
        try {
          transaction(sql, () => {
            const tables = new Set(
              sql
                .prepare("SELECT name FROM sqlite_master WHERE type='table'")
                .all()
                .map((row) => String(row.name)),
            );
            // Provider/account children must be cleared before their account and business parents.
            for (const table of [
              "external_asset_copies",
              "external_assets",
              "external_notifications",
              "external_notification_requests",
              "external_delivery_budget",
              "external_logistics_callbacks",
              "external_logistics_requests",
              "external_shipments",
              "production_reconciliation_items",
              "production_reconciliation",
              "production_webhooks",
              "production_refunds",
              "production_payments",
              "mfa_recovery_codes",
              "mfa_challenges",
              "account_mfa",
              "verification_challenges",
              "verified_contacts",
              "policy_consents",
              "merchant_policy_versions",
              "merchant_profile",
              "account_requests",
            ])
              if (tables.has(table)) sql.exec(`DELETE FROM ${table}`);
            sql.exec(
              "DELETE FROM sessions; DELETE FROM staff_access; DELETE FROM accounts; DELETE FROM rate_limits;",
            );
            ensureAccountSchema(sql);
            const insert = sql.prepare(
              "INSERT INTO accounts(id,username,name,role,password_hash,created_at) VALUES (?, ?, ?, ?, ?, ?)",
            );
            insert.run("u1", "lin", "林小满", "user", userHash, Date.now());
            insert.run("u2", "chen", "陈一禾", "user", userHash, Date.now());
            insert.run(
              "admin",
              "admin",
              "商城管理员",
              "admin",
              adminHash,
              Date.now(),
            );
            sql
              .prepare("INSERT INTO staff_access VALUES ('admin','owner',1)")
              .run();
            if (
              sql
                .prepare(
                  "SELECT 1 FROM sqlite_master WHERE type='table' AND name='ai_daily_usage'",
                )
                .get()
            )
              sql.exec("DELETE FROM ai_daily_usage");
            writeDatabase(sql, createSeed());
            sql.exec(
              "DELETE FROM command_results; DELETE FROM job_queue; DELETE FROM operation_audit;",
            );
          });
        } finally {
          sql.close();
        }
      }
      await use();
    },
    { auto: true },
  ],
});
export { expect };
