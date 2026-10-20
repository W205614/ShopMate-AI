import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/database";
import {
  backupDatabase,
  copyBackupPair,
  inspectBackup,
  verifyBackupReplica,
} from "../src/maintenance";

let directory: string, source: string, target: string;
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "shopmate-backup-replica-"));
  source = join(directory, "original", "snapshot.sqlite");
  target = join(directory, "receiver");
  const sql = openDatabase(":memory:");
  try {
    await backupDatabase(sql, source, { reason: "daily" });
  } finally {
    sql.close();
  }
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe("backup pair receiver verification", () => {
  it("copies both files, revalidates the receiver, and records no offhost claim", () => {
    const result = copyBackupPair(source, target);
    expect(inspectBackup(result.path)).toEqual(inspectBackup(source));
    expect(result).toMatchObject({
      kind: "filesystem-copy",
      offhostVerified: false,
    });
    expect(verifyBackupReplica(result.path).sha256).toBe(result.sha256);
    expect(
      JSON.parse(readFileSync(result.path + ".recovery-point.json", "utf8")),
    ).toMatchObject({
      sha256: result.sha256,
      snapshotAt: result.snapshotAt,
      offhostVerified: false,
    });
    const original = readFileSync(result.path);
    expect(() => copyBackupPair(source, target)).toThrow(
      "BACKUP_REPLICA_TARGET_EXISTS",
    );
    expect(readFileSync(result.path)).toEqual(original);
  });

  it("refuses corrupt source data and the same actual directory", () => {
    expect(() =>
      copyBackupPair(source, join(directory, "original", ".")),
    ).toThrow("BACKUP_REPLICA_SAME_DIRECTORY");
    writeFileSync(source, "corrupt");
    expect(() => copyBackupPair(source, target)).toThrow("校验和");
    expect(
      existsSync(join(target, "snapshot.sqlite.recovery-point.json")),
    ).toBe(false);
  });

  it("preserves a preexisting incomplete destination instead of overwriting it", () => {
    const first = copyBackupPair(source, target);
    rmSync(first.path + ".manifest.json");
    rmSync(first.path + ".recovery-point.json");
    writeFileSync(first.path, "operator must inspect this incomplete copy");
    expect(() => copyBackupPair(source, target)).toThrow(
      "BACKUP_REPLICA_TARGET_EXISTS",
    );
    expect(readFileSync(first.path, "utf8")).toBe(
      "operator must inspect this incomplete copy",
    );
  });

  it("rejects receiver corruption on subsequent verification", () => {
    const result = copyBackupPair(source, target);
    writeFileSync(result.path, "corrupt receiver");
    expect(() => verifyBackupReplica(result.path)).toThrow("校验和");
  });
});
