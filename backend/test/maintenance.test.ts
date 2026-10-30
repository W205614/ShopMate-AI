import { describe, it, expect, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  renameSync,
  readdirSync,
  mkdirSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
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
  it("makes repeated WAL-source snapshots self-contained without staging or final sidecars", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shopmate-single-file-")),
      source = join(dir, "source.sqlite"),
      backups = join(dir, "backups"),
      sql = openDatabase(source);
    mkdirSync(backups);
    try {
      expect(sql.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe(
        "wal",
      );
      for (let i = 0; i < 3; i++) {
        const path = join(backups, `shopmate-daily-${i}.sqlite`);
        const result = await backupDatabase(sql, path, { reason: "daily" });
        expect(inspectBackup(path)).toEqual(result);
        const reader = new DatabaseSync(path, { readOnly: true });
        try {
          expect(
            reader.prepare("PRAGMA journal_mode").get()?.journal_mode,
          ).toBe("delete");
        } finally {
          reader.close();
        }
      }
      expect(readdirSync(backups).sort()).toEqual(
        Array.from({ length: 3 }, (_, i) => [
          `shopmate-daily-${i}.sqlite`,
          `shopmate-daily-${i}.sqlite.manifest.json`,
        ])
          .flat()
          .sort(),
      );
      expect(existsSync(source + "-wal")).toBe(true);
      expect(existsSync(source + "-shm")).toBe(true);
      expect(sql.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe(
        "wal",
      );
    } finally {
      sql.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cleans only the current UUID staging files when copying fails after a snapshot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shopmate-staging-cleanup-")),
      source = join(dir, "source.sqlite"),
      path = join(dir, "backup.sqlite"),
      partial = path + ".partial-this-attempt",
      unknown = path + ".partial-other-attempt-shm",
      sql = openDatabase(source);
    writeFileSync(unknown, "preserve-unknown");
    try {
      await expect(
        backupDatabase(sql, path, {
          temporaryId: "this-attempt",
          afterCopy: () => {
            for (const suffix of ["-wal", "-shm", "-journal", ".manifest.json"])
              writeFileSync(partial + suffix, "interrupted");
            throw new Error("INJECTED_AFTER_COPY_FAILURE");
          },
        }),
      ).rejects.toThrow("INJECTED_AFTER_COPY_FAILURE");
      for (const suffix of ["", "-wal", "-shm", "-journal", ".manifest.json"])
        expect(existsSync(partial + suffix)).toBe(false);
      expect(readFileSync(unknown, "utf8")).toBe("preserve-unknown");
      expect(existsSync(source + "-wal")).toBe(true);
      expect(existsSync(source + "-shm")).toBe(true);
    } finally {
      sql.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("removes sidecars only for selected verified old-format daily backups", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shopmate-old-sidecars-")),
      source = join(dir, "source.sqlite"),
      expired = join(dir, "shopmate-daily-expired.sqlite"),
      kept = join(dir, "shopmate-daily-kept.sqlite"),
      upgrade = join(dir, "shopmate-daily-upgrade.sqlite"),
      unknown = join(dir, "unknown.sqlite.partial-foreign-shm"),
      sql = openDatabase(source);
    const oldFormat = async (path: string, at: string) => {
      await backupDatabase(sql, path, { reason: "daily" });
      const writer = new DatabaseSync(path);
      writer.exec("PRAGMA journal_mode=WAL");
      writer.close();
      const manifest = JSON.parse(
        readFileSync(path + ".manifest.json", "utf8"),
      );
      manifest.createdAt = at;
      manifest.sha256 = createHash("sha256")
        .update(readFileSync(path))
        .digest("hex");
      writeFileSync(path + ".manifest.json", JSON.stringify(manifest));
      const reader = new DatabaseSync(path, { readOnly: true });
      reader.prepare("SELECT revision FROM storage_meta").get();
      reader.close();
      expect(existsSync(path + "-wal")).toBe(true);
      expect(existsSync(path + "-shm")).toBe(true);
    };
    try {
      await oldFormat(expired, "2020-01-01T00:00:00.000Z");
      await oldFormat(kept, "2030-01-01T00:00:00.000Z");
      await backupDatabase(sql, upgrade, { reason: "preupgrade" });
      writeFileSync(expired + "-journal", Buffer.alloc(0));
      writeFileSync(unknown, "preserve-unknown");
      const keptMain = readFileSync(kept),
        keptManifest = readFileSync(kept + ".manifest.json"),
        upgradeMain = readFileSync(upgrade);
      expect(() => inspectBackup(expired)).not.toThrow();
      expect(() => inspectBackup(kept)).not.toThrow();
      expect(pruneDailyBackups(dir, 1)).toEqual([expired]);
      for (const suffix of ["", ".manifest.json", "-wal", "-shm", "-journal"])
        expect(existsSync(expired + suffix)).toBe(false);
      expect(readFileSync(kept).equals(keptMain)).toBe(true);
      expect(readFileSync(kept + ".manifest.json").equals(keptManifest)).toBe(
        true,
      );
      expect(existsSync(kept + "-wal")).toBe(true);
      expect(existsSync(kept + "-shm")).toBe(true);
      expect(readFileSync(upgrade).equals(upgradeMain)).toBe(true);
      expect(readFileSync(unknown, "utf8")).toBe("preserve-unknown");
      expect(existsSync(source + "-wal")).toBe(true);
      expect(existsSync(source + "-shm")).toBe(true);
    } finally {
      sql.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
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

  it("delivers notifications once across restarts and immediately fails invalid payloads", () => {
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
      runDueJobs(sql);
      expect(
        sql
          .prepare(
            "SELECT status,attempts,last_error FROM job_queue WHERE id='bad-job'",
          )
          .get(),
      ).toEqual({
        status: "failed",
        attempts: 1,
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
