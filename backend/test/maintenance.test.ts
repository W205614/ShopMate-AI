import { describe, it, expect, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, readDatabase, writeDatabase } from "../src/database";
import {
  backupDatabase,
  inspectBackup,
  restoreBackup,
  pruneDailyBackups,
} from "../src/maintenance";
import { ensureRecurringJobs, runDueJobs } from "../src/jobs";
import { enqueue } from "../src/runtime";
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

describe("backup and persistent recovery jobs", () => {
  it("restores original main and sidecar bytes when the final replacement rename fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shopmate-restore-failure-")),
      source = join(dir, "backup.sqlite"),
      target = join(dir, "target.sqlite");
    const sql = openDatabase(":memory:"),
      oldConfirm = process.env.CONFIRM_RESTORE,
      actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    try {
      await backupDatabase(sql, source);
      const existing = openDatabase(target);
      existing.close();
      const original = readFileSync(target);
      // Empty offline sidecars model files left by an interrupted process without introducing invalid pages.
      writeFileSync(target + "-wal", Buffer.alloc(0));
      writeFileSync(target + "-shm", Buffer.alloc(0));
      process.env.CONFIRM_RESTORE = "STOPPED_AND_BACKED_UP";
      const movedBytes = new Map<string, Buffer>();
      vi.mocked(renameSync).mockImplementation((from, to) => {
        if (String(from).includes(".restore-"))
          throw new Error("INJECTED_FINAL_RENAME_FAILURE");
        if (String(to).includes(".replaced-"))
          movedBytes.set(String(from), readFileSync(from));
        actual.renameSync(from, to);
      });
      await expect(
        restoreBackup(source, target, { offline: true }),
      ).rejects.toThrow("INJECTED_FINAL_RENAME_FAILURE");
      expect(readFileSync(target).equals(original)).toBe(true);
      for (const suffix of ["", "-wal", "-shm"]) {
        expect(movedBytes.has(target + suffix)).toBe(true);
        expect(
          readFileSync(target + suffix).equals(
            movedBytes.get(target + suffix)!,
          ),
        ).toBe(true);
      }
    } finally {
      vi.mocked(renameSync).mockImplementation(actual.renameSync);
      if (oldConfirm === undefined) delete process.env.CONFIRM_RESTORE;
      else process.env.CONFIRM_RESTORE = oldConfirm;
      sql.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("takes a consistent online snapshot including WAL, accounts and sessions and restores only offline", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shopmate-backup-")),
      path = join(dir, "source.sqlite"),
      dest = join(dir, "backup.sqlite"),
      target = join(dir, "target.sqlite");
    const sql = openDatabase(path),
      oldConfirm = process.env.CONFIRM_RESTORE;
    try {
      sql
        .prepare("INSERT INTO accounts VALUES(?,?,?,?,?,?)")
        .run("kept", "kept", "Kept", "user", "password-hash", 1);
      sql
        .prepare("INSERT INTO sessions VALUES(?,?,?)")
        .run("token-hash", "kept", Date.now() + 86400000);
      const db = readDatabase(sql);
      db.products[0]!.name = "backed-up catalogue";
      db.revision++;
      writeDatabase(sql, db);
      const manifest = await backupDatabase(sql, dest);
      expect(manifest.counts.accounts).toBe(1);
      expect(manifest.counts.sessions).toBe(1);
      expect(inspectBackup(dest)).toEqual(manifest);
      expect(readFileSync(`${dest}.manifest.json`, "utf8")).not.toContain(
        "password-hash",
      );
      const after = readDatabase(sql);
      after.products[0]!.name = "after snapshot";
      after.revision++;
      writeDatabase(sql, after);
      delete process.env.CONFIRM_RESTORE;
      await expect(
        restoreBackup(dest, target, { offline: true }),
      ).rejects.toThrow("CONFIRM_RESTORE");
      process.env.CONFIRM_RESTORE = "STOPPED_AND_BACKED_UP";
      writeFileSync(`${target}.running`, "running");
      await expect(
        restoreBackup(dest, target, { offline: true }),
      ).rejects.toThrow("运行标记");
      rmSync(`${target}.running`);
      const existing = openDatabase(target);
      existing.close();
      const result = await restoreBackup(dest, target, { offline: true });
      expect(result.previousBackup && existsSync(result.previousBackup)).toBe(
        true,
      );
      const restored = openDatabase(target);
      try {
        expect(readDatabase(restored).products[0]!.name).toBe(
          "backed-up catalogue",
        );
        expect(
          restored
            .prepare(
              "SELECT account_id FROM sessions WHERE token_hash='token-hash'",
            )
            .get(),
        ).toEqual({ account_id: "kept" });
        expect(readDatabase(sql).products[0]!.name).toBe("after snapshot");
      } finally {
        restored.close();
      }
    } finally {
      if (oldConfirm === undefined) delete process.env.CONFIRM_RESTORE;
      else process.env.CONFIRM_RESTORE = oldConfirm;
      sql.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects corrupt snapshots before target replacement and retains seven daily backups only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shopmate-retention-")),
      sql = openDatabase(":memory:");
    try {
      for (let i = 0; i < 8; i++)
        await backupDatabase(sql, join(dir, `shopmate-daily-${i}.sqlite`), {
          reason: "daily",
        });
      const upgrade = join(dir, "shopmate-daily-upgrade.sqlite");
      await backupDatabase(sql, upgrade, { reason: "preupgrade" });
      expect(pruneDailyBackups(dir)).toHaveLength(1);
      expect(existsSync(upgrade)).toBe(true);
      expect(inspectBackup(upgrade).reason).toBe("preupgrade");
      writeFileSync(upgrade, "corrupt snapshot");
      expect(() => inspectBackup(upgrade)).toThrow("校验和");
    } finally {
      sql.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("delivers notifications once across restarts and keeps bounded retry failures", () => {
    const dir = mkdtempSync(join(tmpdir(), "shopmate-jobs-")),
      path = join(dir, "jobs.sqlite");
    let sql = openDatabase(path);
    try {
      ensureRecurringJobs(sql);
      enqueue(
        sql,
        "notification",
        { userId: "u1", orderId: "order1", text: "订单已更新" },
        "stable-job",
      );
      runDueJobs(sql);
      expect(readDatabase(sql).notifications).toHaveLength(1);
      sql.close();
      sql = openDatabase(path);
      // Even a repair which requeues a completed task cannot duplicate its notification.
      sql
        .prepare(
          "UPDATE job_queue SET status='pending',run_after=0 WHERE id='stable-job'",
        )
        .run();
      runDueJobs(sql);
      expect(readDatabase(sql).notifications).toHaveLength(1);
      enqueue(sql, "notification", { userId: "u1", text: null }, "bad-job");
      for (let i = 0; i < 5; i++) {
        sql
          .prepare("UPDATE job_queue SET run_after=0 WHERE id='bad-job'")
          .run();
        runDueJobs(sql);
      }
      expect(
        sql
          .prepare(
            "SELECT status,attempts,last_error FROM job_queue WHERE id='bad-job'",
          )
          .get(),
      ).toEqual({
        status: "failed",
        attempts: 5,
        last_error: "INVALID_NOTIFICATION_PAYLOAD",
      });
      expect(readDatabase(sql).notifications).toHaveLength(1);
      expect(
        sql
          .prepare(
            "SELECT count(*) AS n FROM job_queue WHERE id='expiry-recurring'",
          )
          .get(),
      ).toEqual({ n: 1 });
    } finally {
      sql.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
