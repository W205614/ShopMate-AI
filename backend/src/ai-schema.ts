import type { DatabaseSync } from "node:sqlite";
import { ensureRuntimeSchema } from "./runtime";

export function ensureSupportSchema(sql: DatabaseSync) {
  ensureRuntimeSchema(sql);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS support_runs(
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, user_id TEXT NOT NULL,
      message_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL, phase TEXT NOT NULL,
      error TEXT, degraded TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL,
      deadline INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0,
      tools INTEGER NOT NULL DEFAULT 0, output TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS support_run_owner_active ON support_runs(user_id)
      WHERE status IN ('queued','running');
    CREATE INDEX IF NOT EXISTS support_run_chat ON support_runs(conversation_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS support_tool_calls(
      id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES support_runs(id),name TEXT NOT NULL,
      result TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS support_proposals(
      id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES support_runs(id),user_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,kind TEXT NOT NULL,args TEXT NOT NULL,
      snapshot TEXT NOT NULL,summary TEXT NOT NULL,details TEXT NOT NULL,status TEXT NOT NULL,
      expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL,result TEXT);
    CREATE INDEX IF NOT EXISTS support_proposal_chat ON support_proposals(conversation_id);
  `);
}

export function cancelSupportWork(sql: DatabaseSync, conversationId: string) {
  sql
    .prepare(
      "UPDATE support_runs SET status='cancelled',phase='cancelled' WHERE conversation_id=? AND status IN ('queued','running')",
    )
    .run(conversationId);
  sql
    .prepare(
      "UPDATE support_proposals SET status='cancelled' WHERE conversation_id=? AND status='pending'",
    )
    .run(conversationId);
}
