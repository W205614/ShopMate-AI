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
} from "node:fs";
import { resolve, dirname, basename, join } from "node:path";
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
  digests: { business: string; accounts: string; sessions: string };
}
const sha256 = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const manifestPath = (path: string) => `${path}.manifest.json`;

function snapshotDetails(path: string) {
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
          .all();
        counts[name] = rows.length;
        business.update(name).update(JSON.stringify(rows));
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
    const accounts = sql.prepare("SELECT * FROM accounts ORDER BY id").all(),
      sessions = sql
        .prepare("SELECT * FROM sessions ORDER BY token_hash")
        .all();
    counts.accounts = accounts.length;
    counts.sessions = sessions.length;
    return {
      schemaVersion: meta?.schema_version ?? 0,
      businessVersion: meta?.version ?? Number(legacyState!.version),
      revision: meta?.revision ?? Number(legacyState!.revision),
      counts,
      digests: {
        business: business.digest("hex"),
        accounts: sha256(JSON.stringify(accounts)),
        sessions: sha256(JSON.stringify(sessions)),
      },
    };
  } finally {
    sql.close();
  }
}

export function inspectBackup(path: string): BackupManifest {
  const manifest = JSON.parse(
    readFileSync(manifestPath(path), "utf8"),
  ) as BackupManifest;
  if (manifest.format !== 1 || manifest.sha256 !== sha256(readFileSync(path)))
    throw new Error("备份校验和不匹配");
  const details = snapshotDetails(path);
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
}

/** SQLite's online backup API includes a consistent WAL snapshot while requests continue. */
export async function backupDatabase(
  sql: DatabaseSync,
  destination: string,
  options: {
    reason?: BackupManifest["reason"];
    afterCopy?: () => void;
    temporaryId?: string;
  } = {},
) {
  const temporaryId = options.temporaryId ?? randomUUID();
  if (!/^[a-zA-Z0-9-]+$/.test(temporaryId)) throw new Error("备份临时标识无效");
  const path = resolve(destination),
    temporary = `${path}.partial-${temporaryId}`;
  if (existsSync(path) || existsSync(manifestPath(path)))
    throw new Error("备份目标已存在，请使用新的文件名");
  mkdirSync(dirname(path), { recursive: true });
  try {
    await backup(sql, temporary);
    options.afterCopy?.();
    const manifest: BackupManifest = {
      format: 1,
      createdAt: new Date().toISOString(),
      reason: options.reason ?? "manual",
      sha256: sha256(readFileSync(temporary)),
      ...snapshotDetails(temporary),
    };
    writeFileSync(manifestPath(temporary), JSON.stringify(manifest, null, 2), {
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporary, path);
    renameSync(manifestPath(temporary), manifestPath(path));
    return inspectBackup(path);
  } finally {
    for (const partial of [temporary, manifestPath(temporary)])
      if (existsSync(partial)) unlinkSync(partial);
  }
}

/** Only daily files with our manifest are retained; upgrade and manual evidence is never pruned. */
export function pruneDailyBackups(directory: string, keep = 7) {
  if (!Number.isSafeInteger(keep) || keep < 1)
    throw new Error("备份保留数无效");
  if (!existsSync(directory)) return [];
  const candidates = readdirSync(directory)
    .filter((name) => /^shopmate-daily-[\w.-]+\.sqlite$/.test(name))
    .flatMap((name) => {
      const path = join(directory, name);
      try {
        const manifest = inspectBackup(path);
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
    unlinkSync(path);
    unlinkSync(manifestPath(path));
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
    if (sha256(readFileSync(staged)) !== manifest.sha256)
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
        `用法: ${basename(process.argv[1])} backup [目标.sqlite] [--reason=manual|daily|preupgrade] | inspect 备份.sqlite | restore 备份.sqlite 目标.sqlite`,
      );
    record("completed");
  } catch (error) {
    record("failed");
    throw error;
  }
}
