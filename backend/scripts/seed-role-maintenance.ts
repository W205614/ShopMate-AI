/** Synthetic fixture for a fresh acceptance deployment; never a maintenance repair tool. */
import { resolve } from "node:path";
import { openDatabase, transaction } from "../src/database";
import { createAccount } from "../src/auth";
import { ensureRuntimeSchema } from "../src/runtime";

if (process.env.SHOPMATE_ENV !== "acceptance" || process.env.E2E_MUTATIONS_ALLOWED !== "1" || !process.env.DATABASE_PATH)
  throw new Error("EXPLICIT_ISOLATED_ACCEPTANCE_DATABASE_REQUIRED");
const database = resolve(process.env.DATABASE_PATH), sql = openDatabase(database);
try {
  ensureRuntimeSchema(sql);
  if (Number(sql.prepare("SELECT count(*) n FROM accounts WHERE role='user'").get()!.n) !== 0 ||
      Number(sql.prepare("SELECT count(*) n FROM biz_orders").get()!.n) !== 0 ||
      sql.prepare("SELECT 1 FROM job_queue WHERE id LIKE 'maintenance-%'").get())
    throw new Error("FRESH_ACCEPTANCE_DATASET_REQUIRED_NO_EXISTING_USERS_OR_ORDERS");
  const user = await createAccount(sql, { username: "maintenance_fixture", name: "维护合成验收用户", password: "MaintenanceFixture123!" });
  transaction(sql, () => {
    const insert = sql.prepare("INSERT INTO job_queue(id,kind,payload,status,attempts,run_after,last_error,created_at,retry_version) VALUES(?,'notification',?,'failed',5,0,'JOB_EXECUTION_FAILED',?,0)");
    const start = Date.UTC(2026, 9, 21, 0, 0, 0);
    for (let n = 0; n < 25; n++) insert.run(`maintenance-${String(n).padStart(3, "0")}`,
      JSON.stringify({ userId: user.id, text: `维护合成验收通知 ${n}` }), new Date(start + n * 1000).toISOString());
  });
  console.log(JSON.stringify({ syntheticOnly: true, insertedJobs: 25, fixture: "maintenance-000..024" }));
} finally { sql.close(); }
