import { DatabaseSync } from "node:sqlite";
import { reconcile } from "./reconciliation";

const sql = new DatabaseSync(process.argv[2]!, {
  readOnly: true,
  timeout: 1000,
});
try {
  process.send!({ result: reconcile(sql) });
} finally {
  sql.close();
  process.disconnect();
}
