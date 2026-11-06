import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { initialDatabase, openDatabase } from "../src/database";
import { createApp } from "../src/app";

let directory: string, baseline: string, migrated: string;
const fileHash = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
beforeAll(async () => {
  vi.stubEnv("SHOP_MODE", "demo");
  vi.stubEnv("SMTP_HOST", "");
  vi.stubEnv("SMS_ENABLED", "false");
  vi.stubEnv("KUAIDI100_ENABLED", "false");
  vi.stubEnv("BACKUP_S3_ENABLED", "false");
  vi.stubEnv("ASSET_STORAGE", "local");
  vi.stubEnv("PAYMENT_CHANNELS", "");
  vi.stubEnv("PUBLIC_URL", "http://localhost:18086");
  directory = mkdtempSync(join(tmpdir(), "shopmate-compare-cli-"));
  baseline = join(directory, "legacy-v4.sqlite");
  migrated = join(directory, "api-migrated.sqlite");
  const seed = initialDatabase();
  seed.version = 4;
  const original = new DatabaseSync(baseline);
  original.exec(`CREATE TABLE accounts(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE,name TEXT NOT NULL,role TEXT NOT NULL,password_hash TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),expires_at INTEGER NOT NULL);
    CREATE TABLE state(id INTEGER PRIMARY KEY,data TEXT NOT NULL);`);
  original.prepare("INSERT INTO state VALUES(1,?)").run(JSON.stringify(seed));
  original
    .prepare(
      "INSERT INTO accounts VALUES('legacy-user','legacy_customer','隔离旧账号','user','unchanged-password-hash',1234)",
    )
    .run();
  original
    .prepare(
      "INSERT INTO accounts VALUES('legacy-other','legacy_other','隔离其他账号','user','unchanged-other-hash',1235)",
    )
    .run();
  original
    .prepare(
      "INSERT INTO sessions VALUES('synthetic-legacy-session-hash','legacy-user',4102444800000)",
    )
    .run();
  original.close();
  const beforeMigration = fileHash(baseline);
  copyFileSync(baseline, migrated);
  const sql = openDatabase(migrated);
  try {
    const app = await createApp(sql, {
      origins: ["http://localhost"],
      payments: { mode: "demo", channels: [], gateways: {} },
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((done) => server.once("listening", done));
    try {
      const health = await fetch(
        `http://127.0.0.1:${(server.address() as { port: number }).port}/api/health`,
      );
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ status: "ok" });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
    expect(
      sql.prepare("SELECT active FROM accounts WHERE id='legacy-user'").get()!
        .active,
    ).toBe(1);
    expect(
      sql
        .prepare(
          "SELECT token_hash,account_id,expires_at,mfa_verified FROM sessions",
        )
        .get(),
    ).toMatchObject({
      token_hash: "synthetic-legacy-session-hash",
      account_id: "legacy-user",
      expires_at: 4102444800000,
      mfa_verified: 0,
    });
    sql.exec("PRAGMA journal_mode=DELETE");
  } finally {
    sql.close();
  }
  expect(fileHash(baseline)).toBe(beforeMigration);
});
afterAll(() => vi.unstubAllEnvs());

function copy(name: string, source = migrated, change?: string) {
  const path = join(directory, name + ".sqlite");
  copyFileSync(source, path);
  if (change) {
    const sql = new DatabaseSync(path);
    try {
      sql.exec(change);
    } finally {
      sql.close();
    }
  }
  return path;
}
function compare(before: string, after: string, exitCode: number) {
  const hashes = [fileHash(before), fileHash(after)],
    files = readdirSync(directory).sort();
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(
        new URL("../scripts/compare-database-snapshots.mjs", import.meta.url),
      ),
      before,
      after,
    ],
    { encoding: "utf8", timeout: 10000 },
  );
  expect(result.error).toBeUndefined();
  expect([fileHash(before), fileHash(after)]).toEqual(hashes);
  expect(readdirSync(directory).sort()).toEqual(files);
  expect(result.status, result.stderr + result.stdout).toBe(exitCode);
  return JSON.parse(result.stdout) as {
    checks: Record<string, boolean>;
    meta: { baselineVersion: number; live: { version: number } };
  };
}

it("accepts a real legacy account and nonempty session schema after API migration while both CLI inputs remain byte-identical", () => {
  const report = compare(baseline, migrated, 0);
  expect(Object.values(report.checks).every(Boolean)).toBe(true);
  expect(report.meta).toMatchObject({
    baselineVersion: 4,
    live: { version: 5 },
  });
});

it("normalizes absent migration columns on both sides without requiring schema writes", () => {
  const oldShape = copy(
    "both-without-active",
    migrated,
    "ALTER TABLE accounts DROP COLUMN active; ALTER TABLE sessions DROP COLUMN mfa_verified",
  );
  expect(compare(baseline, oldShape, 0).checks.originalAccounts).toBe(true);
});

it("retains an existing disabled account instead of normalizing its active value to one", () => {
  const before = copy(
      "disabled-before",
      migrated,
      "UPDATE accounts SET active=0",
    ),
    after = copy("disabled-after", migrated, "UPDATE accounts SET active=0");
  expect(compare(before, after, 0).checks.originalAccounts).toBe(true);
});

it("rejects re-enabling an account which was already disabled in the baseline", () => {
  const before = copy(
    "disabled-original",
    migrated,
    "UPDATE accounts SET active=0",
  );
  expect(compare(before, migrated, 1).checks.originalAccounts).toBe(false);
});

it.each([
  ["password-hash", "UPDATE accounts SET password_hash='changed-hash'"],
  ["active-zero", "UPDATE accounts SET active=0"],
  [
    "deleted-account",
    "PRAGMA foreign_keys=OFF; DELETE FROM accounts WHERE id='legacy-user'",
  ],
  ["unexpected-field", "ALTER TABLE accounts ADD COLUMN unexpected TEXT"],
])(
  "still rejects %s changes rather than projecting away account fields",
  (name, change) => {
    const changed = copy(name, migrated, change);
    expect(compare(baseline, changed, 1).checks.originalAccounts).toBe(false);
  },
);

it("does not replace an explicitly present null active value with a default", () => {
  const invalid = copy(
    "explicit-null-active",
    baseline,
    "ALTER TABLE accounts ADD COLUMN active INTEGER",
  );
  expect(compare(invalid, migrated, 1).checks.originalAccounts).toBe(false);
});

it("retains existing verified MFA sessions without replacing their value with zero", () => {
  const before = copy(
      "mfa-verified-before",
      migrated,
      "UPDATE sessions SET mfa_verified=1",
    ),
    after = copy(
      "mfa-verified-after",
      migrated,
      "UPDATE sessions SET mfa_verified=1",
    );
  expect(compare(before, after, 0).checks.originalSessions).toBe(true);
});

it.each([
  ["reset-to-zero", "UPDATE sessions SET mfa_verified=0"],
  ["missing-mfa-column", "ALTER TABLE sessions DROP COLUMN mfa_verified"],
])("rejects losing an existing verified MFA fact by %s", (name, change) => {
  const before = copy(
      `mfa-original-${name}`,
      migrated,
      "UPDATE sessions SET mfa_verified=1",
    ),
    after = copy(`mfa-changed-${name}`, migrated, change);
  expect(compare(before, after, 1).checks.originalSessions).toBe(false);
});

it.each([
  [
    "changed-token",
    "UPDATE sessions SET token_hash='synthetic-replaced-session-hash'",
  ],
  ["changed-owner", "UPDATE sessions SET account_id='legacy-other'"],
  ["changed-expiry", "UPDATE sessions SET expires_at=expires_at+1"],
  ["deleted-session", "DELETE FROM sessions"],
  [
    "unexpected-session-field",
    "ALTER TABLE sessions ADD COLUMN unexpected TEXT",
  ],
])(
  "still rejects %s while preserving all other session fields",
  (name, change) => {
    const changed = copy(name, migrated, change);
    const report = compare(baseline, changed, 1);
    expect(report.checks.originalSessions).toBe(false);
    expect(report.checks.originalAccounts).toBe(true);
    expect(report.checks.foreignKeys).toBe(true);
  },
);

it("does not replace an explicitly present null MFA value with a default", () => {
  const invalid = copy(
    "explicit-null-mfa",
    baseline,
    "ALTER TABLE sessions ADD COLUMN mfa_verified INTEGER",
  );
  expect(compare(invalid, migrated, 1).checks.originalSessions).toBe(false);
});
