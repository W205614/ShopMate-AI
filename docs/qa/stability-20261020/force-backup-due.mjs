// Test fixture only: use docker exec after checking the isolated project labels.
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
if (process.env.SHOPMATE_ENV !== 'acceptance' || process.env.LOAD_TEST_ALLOWED !== '1') throw new Error('acceptance only');
const phase = process.argv[2];
if (!['5-clients', '50-clients', '20-clients-endurance'].includes(phase)) throw new Error('explicit phase required');
const path = '/app/data/shopmate.sqlite';
if (!existsSync(path)) throw new Error('existing isolated database required');
const sql = new DatabaseSync(path);
try {
  sql.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
  const users = Number(sql.prepare("SELECT count(*) AS n FROM accounts WHERE role='user' AND id GLOB 'stability-*'").get().n);
  const history = Number(sql.prepare("SELECT count(*) AS n FROM biz_orders WHERE key GLOB 'history-*'").get().n);
  if (users !== 50 || history !== 10000) throw new Error('isolated stability dataset required');
  const previous = sql.prepare('SELECT last_success_at FROM backup_runtime WHERE id=1').get();
  if (!previous?.last_success_at) throw new Error('initial successful backup required');
  const simulatedLastSuccessAt = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  sql.prepare('UPDATE backup_runtime SET last_success_at=? WHERE id=1').run(simulatedLastSuccessAt);
  sql.exec('COMMIT');
  console.log(JSON.stringify({kind:'isolated_due_time_simulation',at:new Date().toISOString(),phase,originalLastSuccessAt:previous.last_success_at,simulatedLastSuccessAt}));
} finally {
  if (sql.isTransaction) sql.exec('ROLLBACK');
  sql.close();
}
