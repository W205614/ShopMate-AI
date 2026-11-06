import { existsSync } from "node:fs";
import { openDatabase } from "../src/database";
import { ensureRuntimeSchema } from "../src/runtime";
import { ensureAccountSchema, resetMfa } from "../src/production/accounts";

const path = process.env.DATABASE_PATH ?? "data/shopmate.sqlite";
const username = process.argv[2];
if (!username || process.argv[3] !== "--offline")
  throw new Error(
    "Usage: node --import tsx scripts/reset-mfa.ts <admin-username> --offline",
  );
if (existsSync(`${path}.running`))
  throw new Error(
    "Stop the API and verify the database is offline before resetting MFA",
  );
if (!existsSync(path))
  throw new Error(
    "Database does not exist; refusing to initialize a new database",
  );
const sql = openDatabase(path);
try {
  ensureRuntimeSchema(sql);
  ensureAccountSchema(sql);
  resetMfa(sql, username);
  console.log(
    "管理二次验证已重置，旧会话及恢复码已撤销；下次密码登录后必须重新设置。",
  );
} finally {
  sql.close();
}
