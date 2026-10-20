import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { openDatabase } from "../src/database";
import {
  backupDatabase,
  inspectBackup,
  backupScratchDirectory,
  cleanBackupScratch,
} from "../src/maintenance";
import { tableFor } from "../src/storage";

const probe = vi.hoisted(() => ({
  progress: undefined as (() => void) | undefined,
  destinations: [] as string[],
}));
vi.mock("node:sqlite", async (original) => {
  const actual = await original<typeof import("node:sqlite")>();
  return {
    ...actual,
    backup: ((sql, path, options) => {
      probe.destinations.push(String(path));
      return actual.backup(sql, path, {
        ...options,
        rate: 1,
        progress: () => probe.progress?.(),
      });
    }) as typeof actual.backup,
  };
});
afterEach(() => {
  probe.progress = undefined;
  probe.destinations = [];
  vi.restoreAllMocks();
});

describe("bounded backup snapshots", () => {
  it("completes one fixed snapshot while another connection writes after every incremental copy step", async () => {
    const directory = mkdtempSync(join(tmpdir(), "shopmate-backup-write-")),
      source = join(directory, "source.sqlite"),
      target = join(directory, "receiver", "copy.sqlite"),
      sql = openDatabase(source),
      reader = new DatabaseSync(source, { readOnly: true });
    const temporaryId = crypto.randomUUID();
    try {
      sql.exec(
        "CREATE TABLE padding(value BLOB); INSERT INTO padding VALUES(zeroblob(524288))",
      );
      const initial = Number(
        sql.prepare("SELECT revision FROM storage_meta WHERE id=1").get()!
          .revision,
      );
      let writes = 0;
      probe.progress = () => {
        if (++writes > 3000)
          throw new Error("BACKUP_RESTARTED_WITH_EVERY_WRITE");
        sql.exec("UPDATE storage_meta SET revision=revision+1 WHERE id=1");
      };
      const phases: string[] = [],
        started = performance.now();
      const manifest = await backupDatabase(reader, target, {
        temporaryId,
        onPhase: (phase) => phases.push(phase),
      });
      expect(performance.now() - started).toBeLessThan(10000);
      expect(writes).toBeGreaterThan(20);
      expect(manifest.revision).toBe(initial);
      expect(
        Number(
          sql.prepare("SELECT revision FROM storage_meta WHERE id=1").get()!
            .revision,
        ),
      ).toBe(initial + writes);
      expect(reader.isTransaction).toBe(false);
      expect(phases).toEqual(["copy", "verify", "publish"]);
      expect(dirname(probe.destinations[0]!)).toBe(
        backupScratchDirectory(temporaryId),
      );
      expect(dirname(probe.destinations[0]!)).not.toBe(dirname(target));
      expect(existsSync(backupScratchDirectory(temporaryId))).toBe(false);
      expect(inspectBackup(target)).toEqual(manifest);
    } finally {
      reader.close();
      sql.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves a caller's pinned query-only transaction and rejects an ambiguous write transaction without ending it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "shopmate-backup-owned-")),
      source = join(directory, "source.sqlite"),
      sql = openDatabase(source),
      reader = new DatabaseSync(source, { readOnly: true });
    try {
      reader.exec("PRAGMA query_only=ON; BEGIN");
      const initial = Number(
        reader.prepare("SELECT revision FROM storage_meta WHERE id=1").get()!
          .revision,
      );
      sql.exec("UPDATE storage_meta SET revision=revision+1 WHERE id=1");
      const manifest = await backupDatabase(
        reader,
        join(directory, "copy.sqlite"),
      );
      expect(manifest.revision).toBe(initial);
      expect(reader.isTransaction).toBe(true);
      reader.exec("ROLLBACK");
      sql.exec("BEGIN IMMEDIATE");
      await expect(
        backupDatabase(sql, join(directory, "unsafe.sqlite")),
      ).rejects.toThrow("BACKUP_SOURCE_TRANSACTION_UNSAFE");
      expect(sql.isTransaction).toBe(true);
      expect(existsSync(join(directory, "unsafe.sqlite"))).toBe(false);
      sql.exec("ROLLBACK");
    } finally {
      if (reader.isTransaction) reader.exec("ROLLBACK");
      if (sql.isTransaction) sql.exec("ROLLBACK");
      reader.close();
      sql.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("streams format-1 business, account and session digests exactly like the original JSON-array encoding", async () => {
    const directory = mkdtempSync(join(tmpdir(), "shopmate-backup-digest-")),
      sql = openDatabase(":memory:");
    try {
      sql
        .prepare("INSERT INTO accounts VALUES (?,?,?,?,?,?)")
        .run("u1", "member", "中文用户", "user", "test-hash", 1);
      sql
        .prepare("INSERT INTO sessions VALUES (?,?,?)")
        .run("session", "u1", Date.now() + 60000);
      const expected = createHash("sha256");
      for (const { name } of sql
        .prepare("SELECT name FROM storage_domains ORDER BY name")
        .all() as { name: string }[]) {
        const rows = sql
          .prepare(
            `SELECT key,position,data FROM ${tableFor(name)} ORDER BY key`,
          )
          .all();
        expected.update(name).update(JSON.stringify(rows));
      }
      const digest = (query: string) =>
        createHash("sha256")
          .update(JSON.stringify(sql.prepare(query).all()))
          .digest("hex");
      const accounts = digest("SELECT * FROM accounts ORDER BY id"),
        sessions = digest("SELECT * FROM sessions ORDER BY token_hash");
      const prepare = DatabaseSync.prototype.prepare;
      vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
        this: DatabaseSync,
        query,
      ) {
        const statement = prepare.call(this, query);
        if (/^SELECT key,position,data FROM biz_/.test(query))
          vi.spyOn(statement, "all").mockImplementation(() => {
            throw new Error("WHOLE_DOMAIN_ALLOCATION_FORBIDDEN");
          });
        return statement;
      });
      const manifest = await backupDatabase(
        sql,
        join(directory, "copy.sqlite"),
      );
      expect(manifest.digests).toMatchObject({
        business: expected.digest("hex"),
        accounts,
        sessions,
      });
      expect(inspectBackup(join(directory, "copy.sqlite"))).toEqual(manifest);
    } finally {
      vi.restoreAllMocks();
      sql.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("ends its own read transaction and removes local staging when copying fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "shopmate-backup-release-")),
      sql = openDatabase(":memory:"),
      temporaryId = crypto.randomUUID();
    try {
      await expect(
        backupDatabase(sql, join(directory, "copy.sqlite"), {
          temporaryId,
          onPhase: () => {
            throw new Error("INJECTED_COPY_FAILURE");
          },
        }),
      ).rejects.toThrow("INJECTED_COPY_FAILURE");
      expect(sql.isTransaction).toBe(false);
      expect(existsSync(backupScratchDirectory(temporaryId))).toBe(false);
    } finally {
      sql.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects nonempty source sidecars and cleans inspection staging after validation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "shopmate-backup-sidecars-")),
      sql = openDatabase(":memory:"),
      target = join(directory, "copy.sqlite"),
      temporaryId = crypto.randomUUID();
    try {
      await backupDatabase(sql, target);
      for (const suffix of ["-wal", "-journal"]) {
        writeFileSync(
          target + suffix,
          "unaccounted committed or interrupted pages",
        );
        expect(() => inspectBackup(target, { temporaryId })).toThrow(
          "BACKUP_NOT_SELF_CONTAINED",
        );
        rmSync(target + suffix);
      }
      expect(inspectBackup(target, { temporaryId }).format).toBe(1);
      expect(existsSync(backupScratchDirectory(temporaryId))).toBe(false);
      const manifest = JSON.parse(
        readFileSync(target + ".manifest.json", "utf8"),
      );
      manifest.counts.accounts++;
      writeFileSync(target + ".manifest.json", JSON.stringify(manifest));
      expect(() => inspectBackup(target, { temporaryId })).toThrow(
        "备份摘要不匹配",
      );
      expect(existsSync(backupScratchDirectory(temporaryId))).toBe(false);
    } finally {
      sql.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("cleans only known owned copy and inspection families and preserves unexpected scratch contents", () => {
    const temporaryId = crypto.randomUUID(),
      directory = backupScratchDirectory(temporaryId);
    mkdirSync(directory);
    try {
      for (const file of [
        "snapshot.sqlite",
        "snapshot.sqlite-journal",
        "inspection.sqlite",
        "inspection.sqlite-wal",
      ])
        writeFileSync(join(directory, file), "owned staging");
      writeFileSync(join(directory, "unrecognized.txt"), "preserve");
      expect(() => cleanBackupScratch(temporaryId)).toThrow();
      expect(readFileSync(join(directory, "unrecognized.txt"), "utf8")).toBe(
        "preserve",
      );
      expect(existsSync(join(directory, "inspection.sqlite-wal"))).toBe(false);
      expect(existsSync(join(directory, "snapshot.sqlite"))).toBe(false);
    } finally {
      rmSync(join(directory, "unrecognized.txt"));
      cleanBackupScratch(temporaryId);
    }
  });
});
