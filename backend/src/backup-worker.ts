import { DatabaseSync } from "node:sqlite";
import { statSync } from "node:fs";
import { dirname } from "node:path";
import {
  backupDatabase,
  pruneDailyBackups,
  copyBackupPair,
} from "./maintenance";

const [source, destination, temporaryId, replicaDirectory] =
  process.argv.slice(2);
let reader: DatabaseSync | undefined,
  phase: "backup" | "retention" | "replica" = "backup";
const releaseSnapshot = () => {
  if (reader?.isTransaction) reader.exec("ROLLBACK");
  reader?.close();
  reader = undefined;
};
try {
  reader = new DatabaseSync(source, { readOnly: true });
  reader.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000");
  if (reader.prepare("PRAGMA journal_mode").get()?.journal_mode !== "wal")
    throw new Error("WAL_REQUIRED");
  reader.exec("BEGIN");
  // BEGIN is deferred: this first read pins the WAL snapshot before backup starts.
  const snapshot = reader
    .prepare("SELECT revision FROM storage_meta WHERE id=1")
    .get() as { revision: number };
  const manifest = await backupDatabase(reader, destination, {
    reason: "daily",
    temporaryId,
    // Release WAL retention before hashing, integrity checks and retention scans.
    afterCopy: releaseSnapshot,
  });
  process.send?.({ type: "created", createdAt: manifest.createdAt });
  phase = "retention";
  process.send?.({ type: "phase", phase });
  pruneDailyBackups(dirname(destination), 7);
  if (replicaDirectory) {
    phase = "replica";
    process.send?.({ type: "phase", phase });
    const replica = copyBackupPair(destination, replicaDirectory);
    process.send?.({
      type: "replicated",
      copiedAt: replica.verifiedAt,
      snapshotAt: replica.snapshotAt,
    });
  }
  process.send?.({
    type: "completed",
    bytes: statSync(destination).size,
    snapshotRevision: snapshot.revision,
  });
} catch {
  process.send?.({ type: "failed", phase });
  process.exitCode = 1;
} finally {
  try {
    releaseSnapshot();
  } catch {
    process.exitCode = 1;
  }
  process.disconnect?.();
}
