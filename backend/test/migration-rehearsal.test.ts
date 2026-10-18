import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSeed } from "../../shared/domain/seed";
import { rehearseMigration } from "../scripts/migration-rehearsal";

describe("offline migration rehearsal", () => {
  it("checks legacy business, accounts, sessions, repeated open and backup restore without touching input", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shopmate-rehearsal-")),
      source = join(dir, "before.sqlite");
    const seed = createSeed();
    seed.version = 3;
    const sql = new DatabaseSync(source);
    sql.exec(`CREATE TABLE accounts(id TEXT PRIMARY KEY,username TEXT,name TEXT,role TEXT,password_hash TEXT,created_at INTEGER);
      CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,account_id TEXT,expires_at INTEGER);
      CREATE TABLE state(id INTEGER PRIMARY KEY,data TEXT);`);
    sql.prepare("INSERT INTO state VALUES(1,?)").run(JSON.stringify(seed));
    sql
      .prepare("INSERT INTO accounts VALUES(?,?,?,?,?,?)")
      .run("u1", "lin", "林小满", "user", "kept-password-hash", 1);
    sql
      .prepare("INSERT INTO sessions VALUES(?,?,?)")
      .run("kept-token-hash", "u1", Date.now() + 86400000);
    sql.close();
    try {
      const report = await rehearseMigration(source, join(dir, "rehearsal"));
      expect(report.inputUnchanged).toBe(true);
      expect(Object.values(report.checks).every(Boolean)).toBe(true);
      expect(report.before.counts.orders).toBe(seed.orders.length);
      expect(report.after.orderTotal).toBe(report.before.orderTotal);
      expect(report.after.stockTotal).toBe(report.before.stockTotal);
      expect(report.after.version).toBe(4);
      await expect(
        rehearseMigration(source, join(dir, "rehearsal")),
      ).rejects.toThrow("已存在");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
