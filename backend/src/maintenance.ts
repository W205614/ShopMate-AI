import { DatabaseSync, backup } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  copyFileSync,
  readdirSync,
  openSync,
  readSync,
  closeSync,
  realpathSync,
  constants,
  rmdirSync,
  statSync,
} from "node:fs";
import { resolve, dirname, basename, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { tableFor } from "./storage";

export interface BackupManifest {
  format: 1;
  createdAt: string;
  reason: "manual" | "daily" | "preupgrade" | "pre-restore";
  sha256: string;
  schemaVersion: number;
  businessVersion: number;
  revision: number;
  counts: Record<string, number>;
  digests: {
    business: string;
    accounts: string;
    sessions: string;
    ai?: string;
  };
}
/** Document BLOBs can make snapshots large; never load the SQLite file into memory. */
function fileSha256(path: string) {
  const hash = createHash("sha256"),
    file = openSync(path, "r"),
    buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytes: number;
    while ((bytes = readSync(file, buffer, 0, buffer.length, null)) > 0)
      hash.update(buffer.subarray(0, bytes));
    return hash.digest("hex");
  } finally {
    closeSync(file);
  }
}

/** Include durable AI state, excluding FTS virtual tables and their derived shadow tables. */
function aiSnapshotDetails(sql: DatabaseSync, counts: Record<string, number>) {
  const tables = (
    sql.prepare("PRAGMA main.table_list").all() as {
      schema: string;
      name: string;
      type: string;
    }[]
  )
    .filter(
      (table) =>
        table.schema === "main" &&
        table.type === "table" &&
        /^(?:ai_|support_|knowledge_)[a-zA-Z0-9_]+$/.test(table.name),
    )
    .sort((a, b) => a.name.localeCompare(b.name, "en"));
  if (!tables.length) return undefined;
  const digest = createHash("sha256");
  // Length-prefixed, typed fields avoid ambiguous concatenation and JSON-expanding BLOBs.
  const field = (value: unknown) => {
    const type =
        value === null
          ? "null"
          : value instanceof Uint8Array
            ? "blob"
            : typeof value,
      bytes =
        value instanceof Uint8Array
          ? value
          : Buffer.from(value === null ? "" : String(value));
    digest.update(`${type}:${bytes.byteLength}:`).update(bytes);
  };
  for (const { name } of tables) {
    field(name);
    const columns = sql.prepare(`PRAGMA main.table_info("${name}")`).all() as {
        name: string;
        pk: number;
      }[],
      primary = columns
        .filter((column) => column.pk)
        .sort((a, b) => a.pk - b.pk),
      order = primary.length
        ? primary
            .map((column) => `"${column.name.replaceAll('"', '""')}"`)
            .join(",")
        : "rowid",
      rows = sql.prepare(`SELECT * FROM "${name}" ORDER BY ${order}`);
    field(JSON.stringify(columns));
    rows.setReadBigInts(true);
    let count = 0;
    for (const row of rows.iterate()) {
      field("row");
      for (const column of columns) field(row[column.name]);
      count++;
    }
    counts[name] = count;
    field(count);
  }
  return digest.digest("hex");
}
const manifestPath = (path: string) => `${path}.manifest.json`;
const backupFiles = (path: string) => [
  path,
  manifestPath(path),
  `${path}-wal`,
  `${path}-shm`,
  `${path}-journal`,
];

export function backupScratchDirectory(temporaryId: string) {
  if (!/^[a-zA-Z0-9-]+$/.test(temporaryId)) throw new Error("备份临时标识无效");
  return join(tmpdir(), `shopmate-backup-${temporaryId}`);
}

/** Only these files belong to the exclusively created staging directory. */
export function cleanBackupScratch(temporaryId: string) {
  const directory = backupScratchDirectory(temporaryId);
  for (const name of ["snapshot.sqlite", "inspection.sqlite"])
    for (const file of backupFiles(join(directory, name)))
      if (existsSync(file)) unlinkSync(file);
  if (existsSync(directory)) rmdirSync(directory);
}

function hashRowArray(
  hash: ReturnType<typeof createHash>,
  rows: Iterable<unknown>,
) {
  hash.update("[");
  let count = 0;
  for (const row of rows) {
    if (count++) hash.update(",");
    hash.update(JSON.stringify(row));
  }
  hash.update("]");
  return count;
}

function snapshotDetails(path: string, includeAi = true) {
  const sql = new DatabaseSync(path, { readOnly: true });
  try {
    const integrity = sql.prepare("PRAGMA integrity_check").all();
    if (integrity.length !== 1 || Object.values(integrity[0])[0] !== "ok")
      throw new Error("备份完整性校验失败");
    if (sql.prepare("PRAGMA foreign_key_check").all().length)
      throw new Error("备份存在外键错误");
    const normalized = sql
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='storage_meta'",
      )
      .get();
    const meta = normalized
      ? (sql
          .prepare(
            "SELECT schema_version,version,revision FROM storage_meta WHERE id=1",
          )
          .get() as
          | { schema_version: number; version: number; revision: number }
          | undefined)
      : undefined;
    const counts: Record<string, number> = {},
      business = createHash("sha256");
    if (meta)
      for (const { name } of sql
        .prepare("SELECT name FROM storage_domains ORDER BY name")
        .all() as { name: string }[]) {
        const rows = sql
          .prepare(
            `SELECT key,position,data FROM ${tableFor(name)} ORDER BY key`,
          )
          .iterate();
        business.update(name);
        counts[name] = hashRowArray(business, rows);
      }
    const legacy = meta
      ? undefined
      : (sql.prepare("SELECT data FROM state WHERE id=1").get() as
          { data: string } | undefined);
    if (!meta && !legacy) throw new Error("备份缺少业务状态和版本信息");
    const legacyState = legacy
      ? (JSON.parse(legacy.data) as Record<string, unknown>)
      : undefined;
    if (legacyState) {
      business.update(legacy!.data);
      for (const [name, value] of Object.entries(legacyState))
        if (Array.isArray(value)) counts[name] = value.length;
    }
    const accounts = createHash("sha256"),
      sessions = createHash("sha256");
    counts.accounts = hashRowArray(
      accounts,
      sql.prepare("SELECT * FROM accounts ORDER BY id").iterate(),
    );
    counts.sessions = hashRowArray(
      sessions,
      sql.prepare("SELECT * FROM sessions ORDER BY token_hash").iterate(),
    );
    const ai = includeAi ? aiSnapshotDetails(sql, counts) : undefined;
    return {
      schemaVersion: meta?.schema_version ?? 0,
      businessVersion: meta?.version ?? Number(legacyState!.version),
      revision: meta?.revision ?? Number(legacyState!.revision),
      counts,
      digests: {
        business: business.digest("hex"),
        accounts: accounts.digest("hex"),
        sessions: sessions.digest("hex"),
        ...(ai ? { ai } : {}),
      },
    };
  } finally {
    sql.close();
  }
}

export function inspectBackup(
  path: string,
  options: { temporaryId?: string } = {},
): BackupManifest {
  const manifest = JSON.parse(
    readFileSync(manifestPath(path), "utf8"),
  ) as BackupManifest;
  const assertStandalone = () => {
    for (const suffix of ["-wal", "-journal"])
      if (existsSync(path + suffix) && statSync(path + suffix).size > 0)
        throw new Error("BACKUP_NOT_SELF_CONTAINED");
  };
  assertStandalone();
  if (manifest.format !== 1 || manifest.sha256 !== fileSha256(path))
    throw new Error("备份校验和不匹配");
  const temporaryId = options.temporaryId ?? randomUUID(),
    directory = backupScratchDirectory(temporaryId),
    staged = join(directory, "inspection.sqlite");
  // Full integrity and logical checks still apply to untrusted input. Sequential
  // copy + SHA identity lets SQLite perform its random reads on fast local storage.
  mkdirSync(directory, { mode: 0o700 });
  try {
    copyFileSync(path, staged, constants.COPYFILE_EXCL);
    assertStandalone();
    if (fileSha256(staged) !== manifest.sha256)
      throw new Error("备份校验和不匹配");
    // Format 1 manifests created before AI support have neither its digest nor counts.
    const details = snapshotDetails(staged, manifest.digests.ai !== undefined);
    for (const key of [
      "schemaVersion",
      "businessVersion",
      "revision",
      "counts",
      "digests",
    ] as const)
      if (JSON.stringify(manifest[key]) !== JSON.stringify(details[key]))
        throw new Error(`备份摘要不匹配: ${key}`);
    return manifest;
  } finally {
    cleanBackupScratch(temporaryId);
  }
}

export interface BackupRecoveryPoint {
  format: 1;
  kind: "filesystem-copy";
  // A mounted directory cannot prove which physical host stores the bytes.
  offhostVerified: false;
  verifiedAt: string;
  snapshotAt: string;
  sha256: string;
  revision: number;
}

/** Reverify at the receiving filesystem before recording a usable recovery point. */
export function verifyBackupReplica(
  path: string,
  options: { temporaryId?: string } = {},
): BackupRecoveryPoint {
  const manifest = inspectBackup(path, options);
  return {
    format: 1,
    kind: "filesystem-copy",
    offhostVerified: false,
    verifiedAt: new Date().toISOString(),
    snapshotAt: manifest.createdAt,
    sha256: manifest.sha256,
    revision: manifest.revision,
  };
}

/** Never overwrite a destination or prune replica/manual/upgrade evidence. */
export function copyBackupPair(
  source: string,
  destinationDirectory: string,
  options: { temporaryId?: string } = {},
) {
  const from = realpathSync(resolve(source));
  inspectBackup(from, options);
  const directory = resolve(destinationDirectory);
  mkdirSync(directory, { recursive: true });
  if (realpathSync(directory) === realpathSync(dirname(from)))
    throw new Error("BACKUP_REPLICA_SAME_DIRECTORY");
  const destination = join(directory, basename(from)),
    recordPath = destination + ".recovery-point.json";
  // Includes a previous incomplete pair: operators must inspect it, never overwrite it.
  if (backupFiles(destination).some(existsSync) || existsSync(recordPath))
    throw new Error("BACKUP_REPLICA_TARGET_EXISTS");
  const owned: string[] = [];
  try {
    for (const [origin, target] of [
      [from, destination],
      [manifestPath(from), manifestPath(destination)],
    ]) {
      copyFileSync(origin, target, constants.COPYFILE_EXCL);
      owned.push(target);
    }
    const point = verifyBackupReplica(destination, options);
    writeFileSync(recordPath, JSON.stringify(point, null, 2), {
      flag: "wx",
      mode: 0o600,
    });
    return { path: destination, ...point };
  } catch (error) {
    // Delete only files exclusively created by this copy attempt.
    for (const target of owned.reverse())
      if (existsSync(target)) unlinkSync(target);
    throw error;
  }
}

/** SQLite's online backup API includes a consistent WAL snapshot while requests continue. */
export async function backupDatabase(
  sql: DatabaseSync,
  destination: string,
  options: {
    reason?: BackupManifest["reason"];
    afterCopy?: () => void;
    temporaryId?: string;
    onPhase?: (phase: "copy" | "verify" | "publish") => void;
  } = {},
) {
  const temporaryId = options.temporaryId ?? randomUUID();
  if (!/^[a-zA-Z0-9-]+$/.test(temporaryId)) throw new Error("备份临时标识无效");
  const path = resolve(destination),
    temporary = `${path}.partial-${temporaryId}`,
    scratchDirectory = backupScratchDirectory(temporaryId),
    scratch = join(scratchDirectory, "snapshot.sqlite");
  if (existsSync(path) || existsSync(manifestPath(path)))
    throw new Error("备份目标已存在，请使用新的文件名");
  mkdirSync(dirname(path), { recursive: true });
  let ownsScratch = false,
    ownsRead = false;
  const releaseRead = () => {
    if (ownsRead && sql.isOpen && sql.isTransaction) sql.exec("ROLLBACK");
    ownsRead = false;
  };
  try {
    // The worker supplies a read-only transaction. Reject ambiguous caller write
    // transactions: node:sqlite would otherwise keep retrying SQLITE_LOCKED.
    if (
      sql.isTransaction &&
      !sql.prepare("PRAGMA query_only").get()?.query_only
    )
      throw new Error("BACKUP_SOURCE_TRANSACTION_UNSAFE");
    if (!sql.isTransaction) {
      sql.exec("BEGIN");
      ownsRead = true;
    }
    // A deferred BEGIN alone does not pin a WAL snapshot.
    sql.prepare("SELECT name FROM sqlite_master LIMIT 1").get();
    mkdirSync(scratchDirectory, { mode: 0o700 });
    ownsScratch = true;
    options.onPhase?.("copy");
    // SQLite performs small random page I/O; keep it on the container's local
    // filesystem rather than a Docker Desktop host bind or network receiver.
    await backup(sql, scratch);
    releaseRead();
    options.afterCopy?.();
    options.onPhase?.("verify");
    // Only this attempt owns the copied file. Make it self-contained before hashing;
    // later read-only inspections must not recreate persistent WAL/SHM sidecars.
    const copied = new DatabaseSync(scratch);
    try {
      if (
        copied.prepare("PRAGMA journal_mode=DELETE").get()?.journal_mode !==
        "delete"
      )
        throw new Error("备份副本无法切换为独立文件模式");
    } finally {
      copied.close();
    }
    const manifest: BackupManifest = {
      format: 1,
      createdAt: new Date().toISOString(),
      reason: options.reason ?? "manual",
      sha256: fileSha256(scratch),
      ...snapshotDetails(scratch),
    };
    options.onPhase?.("publish");
    copyFileSync(scratch, temporary, constants.COPYFILE_EXCL);
    if (fileSha256(temporary) !== manifest.sha256)
      throw new Error("BACKUP_PUBLISH_CHECKSUM_MISMATCH");
    writeFileSync(manifestPath(temporary), JSON.stringify(manifest, null, 2), {
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporary, path);
    renameSync(manifestPath(temporary), manifestPath(path));
    // The published bytes equal the fully validated local snapshot. Reopening
    // SQLite here would repeat slow random reads on the receiving filesystem.
    return manifest;
  } finally {
    releaseRead();
    for (const partial of backupFiles(temporary))
      if (existsSync(partial)) unlinkSync(partial);
    if (ownsScratch) cleanBackupScratch(temporaryId);
  }
}

/** Only daily files with our manifest are retained; upgrade and manual evidence is never pruned. */
export function pruneDailyBackups(
  directory: string,
  keep = 7,
  options: { temporaryId?: string } = {},
) {
  if (!Number.isSafeInteger(keep) || keep < 1)
    throw new Error("备份保留数无效");
  if (!existsSync(directory)) return [];
  const candidates = readdirSync(directory)
    .filter((name) => /^shopmate-daily-[\w.-]+\.sqlite$/.test(name))
    .flatMap((name) => {
      const path = join(directory, name);
      try {
        const manifest = inspectBackup(path, options);
        return manifest.reason === "daily"
          ? [{ path, createdAt: manifest.createdAt }]
          : [];
      } catch {
        return [];
      }
    })
    .sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) || b.path.localeCompare(a.path),
    );
  const removed: string[] = [];
  for (const { path } of candidates.slice(keep)) {
    // These exact files belong to the validated backup selected for deletion.
    // Retained snapshots, source sidecars and unrecognized staging files stay untouched.
    for (const file of backupFiles(path))
      if (existsSync(file)) unlinkSync(file);
    removed.push(path);
  }
  return removed;
}

/** Restore is deliberately offline; the runtime marker is created and removed by the server. */
export async function restoreBackup(
  source: string,
  target: string,
  options: { offline?: boolean } = {},
) {
  const from = resolve(source),
    to = resolve(target);
  if (
    !options.offline ||
    process.env.CONFIRM_RESTORE !== "STOPPED_AND_BACKED_UP"
  )
    throw new Error(
      "恢复前必须停止服务并设置 CONFIRM_RESTORE=STOPPED_AND_BACKED_UP",
    );
  if (from === to) throw new Error("备份文件和恢复目标必须不同");
  if (existsSync(`${to}.running`))
    throw new Error("检测到运行标记，停止服务并核实离线状态后再恢复");
  const manifest = inspectBackup(from);
  if (manifest.schemaVersion > 1 || manifest.businessVersion > 4)
    throw new Error("备份版本高于当前程序支持范围");
  mkdirSync(dirname(to), { recursive: true });
  let previousBackup: string | undefined;
  if (existsSync(to)) {
    previousBackup = join(
      dirname(from),
      `shopmate-pre-restore-${Date.now()}-${randomUUID()}.sqlite`,
    );
    const old = new DatabaseSync(to, { readOnly: true });
    try {
      await backupDatabase(old, previousBackup, { reason: "pre-restore" });
    } finally {
      old.close();
    }
  }
  const staged = `${to}.restore-${randomUUID()}`,
    displaced = `${to}.replaced-${randomUUID()}`;
  const moved: { source: string; backup: string }[] = [];
  try {
    copyFileSync(from, staged);
    if (fileSha256(staged) !== manifest.sha256)
      throw new Error("恢复复制校验失败");
    if (existsSync(`${to}.running`))
      throw new Error("恢复期间检测到服务启动，取消替换");
    try {
      // Preserve the exact old main and sidecars until the replacement succeeds.
      for (const suffix of ["", "-wal", "-shm"])
        if (existsSync(to + suffix)) {
          renameSync(to + suffix, displaced + suffix);
          moved.push({ source: to + suffix, backup: displaced + suffix });
        }
      renameSync(staged, to);
    } catch (error) {
      for (const old of moved.toReversed())
        if (existsSync(old.backup)) renameSync(old.backup, old.source);
      throw error;
    }
    const retainedOriginalFiles: string[] = [];
    for (const old of moved)
      try {
        unlinkSync(old.backup);
      } catch {
        retainedOriginalFiles.push(old.backup);
      }
    return { target: to, previousBackup, manifest, retainedOriginalFiles };
  } finally {
    if (existsSync(staged)) unlinkSync(staged);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [command, file, target] = process.argv
    .slice(2)
    .filter((value) => !value.startsWith("--"));
  const maintenanceEvent = {
    event: "maintenance_command",
    actor: "local-maintenance",
    action: command ?? "unknown",
    requestId: randomUUID(),
    object: basename((command === "restore" ? target : file) ?? "backup"),
  };
  const record = (result: string) =>
    console.error(
      JSON.stringify({
        ...maintenanceEvent,
        at: new Date().toISOString(),
        result,
      }),
    );
  record("started");
  try {
    if (command === "backup") {
      const reason =
        process.argv
          .slice(2)
          .find((value) => value.startsWith("--reason="))
          ?.slice("--reason=".length) ?? "manual";
      if (!["manual", "daily", "preupgrade", "pre-restore"].includes(reason))
        throw new Error("备份原因无效");
      const source = process.env.DATABASE_PATH ?? "data/shopmate.sqlite",
        destination =
          file ??
          join(
            process.env.BACKUP_DIR ?? "backups",
            `shopmate-manual-${Date.now()}.sqlite`,
          );
      const sql = new DatabaseSync(source, { readOnly: true });
      try {
        console.log(
          JSON.stringify(
            {
              path: resolve(destination),
              ...(await backupDatabase(sql, destination, {
                reason: reason as BackupManifest["reason"],
              })),
            },
            null,
            2,
          ),
        );
      } finally {
        sql.close();
      }
    } else if (command === "inspect" && file)
      console.log(JSON.stringify(inspectBackup(file), null, 2));
    else if (command === "replicate" && file && target)
      console.log(JSON.stringify(copyBackupPair(file, target), null, 2));
    else if (command === "verify-replica" && file)
      console.log(JSON.stringify(verifyBackupReplica(file), null, 2));
    else if (command === "restore" && file && target)
      console.log(
        JSON.stringify(
          await restoreBackup(file, target, { offline: true }),
          null,
          2,
        ),
      );
    else
      throw new Error(
        `用法: ${basename(process.argv[1])} backup [目标.sqlite] [--reason=manual|daily|preupgrade] | inspect 备份.sqlite | replicate 备份.sqlite 目标目录 | verify-replica 目标备份.sqlite | restore 备份.sqlite 目标.sqlite`,
      );
    record("completed");
  } catch (error) {
    record("failed");
    throw error;
  }
}
