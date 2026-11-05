import { openDatabase, transaction } from "./database";
import { hashPassword } from "./auth";
import { registerSchema } from "./validation";
import { ensureRuntimeSchema, audit } from "./runtime";

const input = registerSchema.parse({
  username: process.env.ADMIN_USERNAME ?? "admin",
  name: "商城管理员",
  password: process.env.ADMIN_PASSWORD,
});
const sql = openDatabase(process.env.DATABASE_PATH ?? "data/shopmate.sqlite");
ensureRuntimeSchema(sql);
try {
  const account = sql
    .prepare("SELECT id FROM accounts WHERE username=? AND role='admin'")
    .get(input.username);
  if (!account) throw new Error("管理员不存在，请先启动服务完成初始化");
  const hash = await hashPassword(input.password);
  transaction(sql, () => {
    sql
      .prepare("UPDATE accounts SET password_hash=? WHERE id=?")
      .run(hash, account.id);
    sql.prepare("DELETE FROM sessions WHERE account_id=?").run(account.id);
    audit(
      sql,
      "local-maintenance",
      "adminPasswordReset",
      crypto.randomUUID(),
      "completed",
      String(account.id),
    );
  });
  console.log("管理员密码已更新，原有管理员会话已失效。");
} finally {
  sql.close();
}
