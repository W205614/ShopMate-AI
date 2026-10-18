import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  statSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { openDatabase } from "../src/database";
import { backupDatabase, inspectBackup } from "../src/maintenance";
import {
  runAutomaticBackup,
  cancelAutomaticBackup,
} from "../src/automatic-backup";

let sql: DatabaseSync, directory: string, source: string, destination: string;
let output: ReturnType<typeof vi.spyOn>, errors: ReturnType<typeof vi.spyOn>;
const logged = (spy: ReturnType<typeof vi.spyOn>): Record<string, unknown>[] =>
  spy.mock.calls.map(([line]: unknown[]) => JSON.parse(String(line)));
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "shopmate-worker-"));
  source = join(directory, "source.sqlite");
  mkdirSync(join(directory, "backups"));
  destination = join(directory, "backups", "shopmate-daily-current.sqlite");
  sql = openDatabase(source);
  output = vi.spyOn(console, "log").mockImplementation(() => {});
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  cancelAutomaticBackup();
  sql.close();
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

describe("automatic backup worker", () => {
  it("completes a fixed WAL snapshot during writes while the API thread keeps progressing and retains seven", async () => {
    sql.exec(
      "CREATE TABLE worker_probe(value INTEGER); INSERT INTO worker_probe VALUES(0); CREATE TABLE payload(id INTEGER PRIMARY KEY, data TEXT); BEGIN",
    );
    const insert = sql.prepare("INSERT INTO payload VALUES(?,?)");
    for (let i = 0; i < 1500; i++) insert.run(i, "x".repeat(1500));
    sql.exec("COMMIT");
    for (let i = 0; i < 7; i++)
      await backupDatabase(
        sql,
        join(directory, "backups", `shopmate-daily-old-${i}.sqlite`),
        { reason: "daily" },
      );
    let ticks = 0;
    const timer = setInterval(() => {
      sql.exec(
        "BEGIN IMMEDIATE; UPDATE worker_probe SET value=value+1; UPDATE storage_meta SET revision=revision+1; COMMIT",
      );
      ticks++;
    }, 2);
    const created = vi.fn();
    let result;
    try {
      result = await runAutomaticBackup(source, destination, created);
    } finally {
      clearInterval(timer);
    }
    const copy = new DatabaseSync(destination, { readOnly: true });
    try {
      expect(
        copy.prepare("SELECT revision FROM storage_meta").get()?.revision,
      ).toBe(result.snapshotRevision);
      expect(copy.prepare("SELECT value FROM worker_probe").get()?.value).toBe(
        result.snapshotRevision,
      );
      expect(
        sql.prepare("SELECT value FROM worker_probe").get()!.value,
      ).toBeGreaterThan(result.snapshotRevision);
    } finally {
      copy.close();
    }
    expect(ticks).toBeGreaterThan(5);
    expect(created).toHaveBeenCalledOnce();
    expect(inspectBackup(destination).revision).toBe(result.snapshotRevision);
    expect(
      readdirSync(join(directory, "backups")).filter((file) =>
        file.endsWith(".sqlite"),
      ),
    ).toHaveLength(7);
    const [started, completed] = logged(output);
    expect(started).toMatchObject({
      event: "backup_started",
      phase: "backup",
      file: "shopmate-daily-current.sqlite",
    });
    expect(completed).toMatchObject({
      event: "backup_completed",
      phase: "retention",
      backupId: started.backupId,
      bytes: statSync(destination).size,
    });
    expect(Number(completed.durationMs)).toBeGreaterThan(0);
    expect(Number.isFinite(Date.parse(String(completed.at)))).toBe(true);
    expect(JSON.stringify(logged(output))).not.toContain(directory);
    expect(errors).not.toHaveBeenCalled();
  }, 30000);

  it("rejects worker errors with safe logs and releases its slot for a subsequent retry", async () => {
    const created = vi.fn();
    await expect(
      runAutomaticBackup(
        join(directory, "password=private-credential.sqlite"),
        destination,
        created,
      ),
    ).rejects.toThrow("BACKUP_WORKER_FAILED");
    expect(created).not.toHaveBeenCalled();
    expect(logged(errors)[0]).toMatchObject({
      event: "backup_failed",
      phase: "backup",
      code: "BACKUP_WORKER_FAILED",
      backupId: logged(output)[0].backupId,
    });
    expect(JSON.stringify(logged(errors))).not.toContain("private-credential");
    expect(JSON.stringify(logged(errors))).not.toContain(directory);
    await runAutomaticBackup(source, destination, created);
    expect(created).toHaveBeenCalledOnce();
    expect(logged(output)[1].backupId).not.toBe(logged(output)[0].backupId);
  });

  it("has no queue, handles unexpected termination and permits another attempt", async () => {
    const first = runAutomaticBackup(source, destination);
    await expect(
      runAutomaticBackup(source, join(directory, "other.sqlite")),
    ).rejects.toThrow("BACKUP_ALREADY_RUNNING");
    await delay(25);
    cancelAutomaticBackup();
    await expect(first).rejects.toThrow("BACKUP_WORKER_EXIT");
    expect(
      readdirSync(join(directory, "backups")).some((file) =>
        file.includes(".partial-"),
      ),
    ).toBe(false);
    await runAutomaticBackup(source, destination);
  });

  it("times out the child and cleans only its own staging files without touching other backups", async () => {
    const attempt = runAutomaticBackup(source, destination, undefined, {
      timeoutMs: 1,
    });
    const id = logged(output)[0].backupId;
    const partial = `${destination}.partial-${id}`;
    writeFileSync(partial, "interrupted-copy");
    writeFileSync(partial + ".manifest.json", "interrupted-manifest");
    writeFileSync(partial + "-wal", "interrupted-wal");
    const unrelated = destination + ".partial-unrelated";
    writeFileSync(unrelated, "preserve-me");
    await expect(attempt).rejects.toThrow("BACKUP_TIMEOUT");
    expect(existsSync(partial)).toBe(false);
    expect(existsSync(partial + ".manifest.json")).toBe(false);
    expect(existsSync(partial + "-wal")).toBe(false);
    expect(readFileSync(unrelated, "utf8")).toBe("preserve-me");
    expect(logged(errors)[0]).toMatchObject({
      event: "backup_failed",
      code: "BACKUP_TIMEOUT",
    });
    await runAutomaticBackup(source, destination);
  });

  it("refuses an existing destination and preserves its bytes", async () => {
    writeFileSync(destination, "existing-original");
    await expect(runAutomaticBackup(source, destination)).rejects.toThrow(
      "BACKUP_TARGET_EXISTS",
    );
    expect(readFileSync(destination, "utf8")).toBe("existing-original");
  });
});
