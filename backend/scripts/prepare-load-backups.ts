import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { backupDatabase } from "../src/maintenance";

// Prepare the full daily retention set while the NEW acceptance service is stopped.
if (process.env.SHOPMATE_ENV !== "acceptance" || process.env.LOAD_TEST_ALLOWED !== "1")
  throw new Error("Explicit isolated acceptance environment is required");
const database = process.env.DATABASE_PATH, directory = process.env.BACKUP_DIR;
if (!database || !directory || !existsSync(directory) || existsSync(database + ".running"))
  throw new Error("Seeded, stopped database and independent backup directory are required");
if (readdirSync(directory).length || resolve(database).startsWith(resolve(directory) + "/"))
  throw new Error("Use a new empty backup directory separate from the database");
const sql = new DatabaseSync(database, { readOnly: true });
try {
  const history = Number(process.env.LOAD_HISTORY);
  if (![0, 10000].includes(history) ||
      !sql.prepare("SELECT id FROM accounts WHERE username='loaduser'").get() ||
      sql.prepare("SELECT count(*) AS n FROM biz_orders").get()?.n !== history)
    throw new Error("Expected newly seeded acceptance dataset");
  for (let index = 0; index < 7; index++)
    await backupDatabase(sql, join(directory, `shopmate-daily-preload-${index}.sqlite`), { reason: "daily" });
  console.log(JSON.stringify({ event: "load_backups_prepared", history, count: 7 }));
} finally { sql.close(); }
