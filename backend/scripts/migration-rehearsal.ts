import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { openDatabase, readDatabase } from "../src/database";
import {
  backupDatabase,
  inspectBackup,
  restoreBackup,
} from "../src/maintenance";
import type { Database } from "../../shared/domain/types";

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
function oldShape(actual: unknown, original: unknown, root = false): unknown {
  if (Array.isArray(original)) {
    if (!Array.isArray(actual) || actual.length !== original.length)
      throw new Error("业务集合长度变化");
    return original.map((item, index) => oldShape(actual[index], item));
  }
  if (original && typeof original === "object") {
    if (!actual || typeof actual !== "object") throw new Error("业务对象丢失");
    return Object.fromEntries(
      Object.entries(original)
        .filter(([key]) => !root || key !== "version")
        .map(([key, item]) => [
          key,
          oldShape((actual as Record<string, unknown>)[key], item),
        ]),
    );
  }
  return actual;
}
function accountFacts(sql: DatabaseSync) {
  return {
    accounts: sql.prepare("SELECT * FROM accounts ORDER BY id").all(),
    sessions: sql.prepare("SELECT * FROM sessions ORDER BY token_hash").all(),
  };
}
function legacyBytes(sql: DatabaseSync) {
  return (
    sql.prepare("SELECT data FROM state WHERE id=1").get() as { data: string }
  ).data;
}
function businessFacts(db: Database) {
  return {
    version: db.version,
    revision: db.revision,
    counts: Object.fromEntries(
      Object.entries(db)
        .filter(([, value]) => Array.isArray(value))
        .map(([key, value]) => [key, (value as unknown[]).length]),
    ),
    orderTotal: String(
      db.orders.reduce((total, order) => total + BigInt(order.total), 0n),
    ),
    refundedTotal: String(
      db.orders.reduce(
        (total, order) => total + BigInt(order.refundedAmount ?? 0),
        0n,
      ),
    ),
    stockTotal: String(
      db.products
        .flatMap((product) => product.skus)
        .reduce((total, sku) => total + BigInt(sku.stock), 0n),
    ),
    digest: digest(canonical(db)),
  };
}

/** The input must be an explicit offline snapshot; only newly created rehearsal files are migrated. */
export async function rehearseMigration(source: string, directory: string) {
  const input = resolve(source),
    output = resolve(directory);
  if (!existsSync(input) || existsSync(input + ".running"))
    throw new Error("请提供已停止业务进程的独立数据库快照");
  if (existsSync(output)) throw new Error("演练输出目录已存在，请使用新的目录");
  mkdirSync(dirname(output), { recursive: true });
  mkdirSync(output);
  const sourceHash = createHash("sha256")
    .update(readFileSync(input))
    .digest("hex");
  const sourceSql = new DatabaseSync(input, { readOnly: true });
  let original: Database,
    legacy: string,
    identity: ReturnType<typeof accountFacts>;
  try {
    legacy = legacyBytes(sourceSql);
    const normalized = sourceSql
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='storage_meta'",
      )
      .get();
    original = structuredClone(
      normalized ? readDatabase(sourceSql) : (JSON.parse(legacy) as Database),
    );
    identity = accountFacts(sourceSql);
    await backupDatabase(sourceSql, join(output, "before.sqlite"), {
      reason: "preupgrade",
    });
  } finally {
    sourceSql.close();
  }
  const working = join(output, "migrated.sqlite");
  copyFileSync(join(output, "before.sqlite"), working);
  let sql = openDatabase(working),
    migrated: Database;
  try {
    migrated = structuredClone(readDatabase(sql));
    if (
      digest(canonical(oldShape(migrated, original, true))) !==
      digest(canonical(oldShape(original, original, true)))
    )
      throw new Error("迁移改变了已有业务字段");
    if (digest(accountFacts(sql)) !== digest(identity))
      throw new Error("迁移改变账号或会话");
    if (legacyBytes(sql) !== legacy)
      throw new Error("迁移改变旧 JSON 证据字节");
    for (const originalOrder of original.orders) {
      const order = migrated.orders.find(
        (value) => value.id === originalOrder.id,
      )!;
      for (const policy of [
        "inventoryPolicy",
        "pointsPolicy",
        "afterSaleDays",
      ] as const)
        if (originalOrder[policy] === undefined && order[policy] !== undefined)
          throw new Error("历史订单被强行赋予新策略");
    }
  } finally {
    sql.close();
  }
  sql = openDatabase(working);
  try {
    if (digest(canonical(readDatabase(sql))) !== digest(canonical(migrated)))
      throw new Error("重复打开改变业务状态");
    await backupDatabase(sql, join(output, "after.sqlite"), {
      reason: "manual",
    });
  } finally {
    sql.close();
  }
  inspectBackup(join(output, "before.sqlite"));
  inspectBackup(join(output, "after.sqlite"));
  const previousConfirm = process.env.CONFIRM_RESTORE;
  process.env.CONFIRM_RESTORE = "STOPPED_AND_BACKED_UP";
  try {
    await restoreBackup(
      join(output, "after.sqlite"),
      join(output, "restored.sqlite"),
      { offline: true },
    );
  } finally {
    if (previousConfirm === undefined) delete process.env.CONFIRM_RESTORE;
    else process.env.CONFIRM_RESTORE = previousConfirm;
  }
  const restored = openDatabase(join(output, "restored.sqlite"));
  try {
    if (
      digest(canonical(readDatabase(restored))) !== digest(canonical(migrated))
    )
      throw new Error("备份恢复后业务状态不同");
    if (digest(accountFacts(restored)) !== digest(identity))
      throw new Error("备份恢复后账号或会话不同");
    if (legacyBytes(restored) !== legacy)
      throw new Error("备份恢复后旧 JSON 证据不同");
  } finally {
    restored.close();
  }
  const inputUnchanged =
    createHash("sha256").update(readFileSync(input)).digest("hex") ===
    sourceHash;
  if (!inputUnchanged) throw new Error("演练修改了输入快照");
  const report = {
    createdAt: new Date().toISOString(),
    source: input,
    output,
    sourceFileSha256: sourceHash,
    inputUnchanged,
    checks: {
      existingBusinessFields: true,
      accountsAndSessions: true,
      legacyBytes: true,
      historicalPolicies: true,
      repeatedOpen: true,
      backupRestore: true,
      integrity: true,
    },
    before: businessFacts(original),
    after: businessFacts(migrated),
    identityDigest: digest(identity),
  };
  writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2), {
    flag: "wx",
  });
  return report;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [source, directory] = process.argv.slice(2);
  if (!source || !directory)
    throw new Error(
      "用法: node --import tsx scripts/migration-rehearsal.ts 独立快照.sqlite 新演练目录",
    );
  console.log(
    JSON.stringify(await rehearseMigration(source, directory), null, 2),
  );
}
