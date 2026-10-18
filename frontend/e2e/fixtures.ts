import { test as base, expect } from "@playwright/test";
import { openDatabase, writeDatabase } from "../../backend/src/database";
import { randomBytes, scryptSync } from "node:crypto";
import { resolve } from "node:path";
import { createSeed } from "../../shared/domain/seed";

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
        sql.exec(
          "BEGIN IMMEDIATE; DELETE FROM sessions; DELETE FROM staff_access; DELETE FROM accounts; DELETE FROM rate_limits;",
        );
        const insert = sql.prepare(
          "INSERT INTO accounts VALUES (?, ?, ?, ?, ?, ?)",
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
        writeDatabase(sql, createSeed());
        sql.exec(
          "DELETE FROM command_results; DELETE FROM job_queue; DELETE FROM operation_audit;",
        );
        sql.exec("COMMIT");
        sql.close();
      }
      await use();
    },
    { auto: true },
  ],
});
export { expect };
