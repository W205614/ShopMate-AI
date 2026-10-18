import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { backupDatabase, pruneDailyBackups } from "./maintenance";

/** One scheduled attempt; scheduling, exclusivity and shutdown stay with the caller. */
export async function runAutomaticBackup(
  sql: DatabaseSync,
  destination: string,
  onBackupCreated: () => void = () => {},
) {
  const backupId = randomUUID(),
    file = basename(destination),
    started = performance.now();
  const event = (name: string, fields: Record<string, unknown> = {}) =>
    JSON.stringify({
      level: name === "backup_failed" ? "error" : "info",
      event: name,
      at: new Date().toISOString(),
      backupId,
      file,
      ...fields,
    });
  console.log(event("backup_started"));
  try {
    await backupDatabase(sql, destination, { reason: "daily" });
    // Preserve the existing schedule: retention failure must not create another same-day backup.
    onBackupCreated();
    const bytes = statSync(destination).size;
    pruneDailyBackups(dirname(destination), 7);
    console.log(
      event("backup_completed", {
        durationMs: Math.round(performance.now() - started),
        bytes,
      }),
    );
  } catch (error) {
    console.error(
      event("backup_failed", {
        durationMs: Math.round(performance.now() - started),
      }),
    );
    throw error;
  }
}
