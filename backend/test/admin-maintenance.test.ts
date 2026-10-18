import { it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { openDatabase } from "../src/database";
import { createAccount, checkPassword } from "../src/auth";
it("password maintenance revokes sessions and records an atomic audit without credentials", async () => {
  const directory = mkdtempSync(join(tmpdir(), "shopmate-admin-")),
    file = join(directory, "acceptance.sqlite");
  let sql = openDatabase(file);
  try {
    const account = await createAccount(
      sql,
      { username: "owner", name: "店主", password: "PreviousPass123!" },
      "admin",
    );
    sql
      .prepare("INSERT INTO sessions VALUES (?,?,?)")
      .run("old-session", account.id, Date.now() + 60000);
    sql.close();
    await promisify(execFile)(
      process.execPath,
      ["--import", "tsx", resolve("src/admin.ts")],
      {
        cwd: resolve("."),
        env: {
          ...process.env,
          DATABASE_PATH: file,
          ADMIN_USERNAME: "owner",
          ADMIN_PASSWORD: "ChangedPass123!",
        },
      },
    );
    sql = openDatabase(file);
    expect(sql.prepare("SELECT * FROM sessions").all()).toHaveLength(0);
    const row = sql
      .prepare("SELECT password_hash FROM accounts WHERE id=?")
      .get(account.id)!;
    expect(
      await checkPassword("ChangedPass123!", String(row.password_hash)),
    ).toBe(true);
    const audit = sql.prepare("SELECT * FROM operation_audit").all();
    expect(audit).toHaveLength(1);
    expect(audit[0]!.action).toBe("adminPasswordReset");
    expect(audit[0]!.object_id).toBe(account.id);
    expect(JSON.stringify(audit)).not.toContain("ChangedPass123");
  } finally {
    try {
      sql.close();
    } catch {
      /* child failure may leave the original closed handle */
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
