import { randomUUID } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { access, rm } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanBackupScratch } from "./maintenance";

let active: ChildProcess | undefined,
  running = false;
export function cancelAutomaticBackup() {
  active?.kill("SIGKILL");
}
const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/** One child, no waiting queue. Copying, verification and retention never run in the API. */
export async function runAutomaticBackup(
  source: string,
  destination: string,
  onBackupCreated: (createdAt: string) => void = () => {},
  options: {
    timeoutMs?: number;
    replicaDirectory?: string;
    onReplicaCreated?: (copiedAt: string, snapshotAt: string) => void;
  } = {},
) {
  if (running) throw new Error("BACKUP_ALREADY_RUNNING");
  running = true;
  const backupId = randomUUID(),
    file = basename(destination),
    started = performance.now(),
    path = resolve(destination);
  let phase = "backup",
    created = false,
    ownsTarget = false,
    ownsScratch = false,
    phaseStarted = started;
  const phaseDurations: Record<string, number> = {};
  const enterPhase = (next: string) => {
    const now = performance.now();
    phaseDurations[phase] =
      (phaseDurations[phase] ?? 0) + Math.round(now - phaseStarted);
    phaseStarted = now;
    phase = next;
  };
  const event = (name: string, fields: Record<string, unknown> = {}) =>
    JSON.stringify({
      level: name === "backup_failed" ? "error" : "info",
      event: name,
      at: new Date().toISOString(),
      backupId,
      file,
      phase,
      ...fields,
    });
  console.log(event("backup_started"));
  try {
    const timeout = options.timeoutMs ?? 120000;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120000)
      throw new Error("BACKUP_TIMEOUT_INVALID");
    if ((await exists(path)) || (await exists(path + ".manifest.json")))
      throw new Error("BACKUP_TARGET_EXISTS");
    ownsTarget = true;
    const env = Object.fromEntries(
      ["PATH", "TZ", "TEMP", "TMP", "TMPDIR", "SystemRoot"]
        .filter((key) => process.env[key] !== undefined)
        .map((key) => [key, process.env[key]!]),
    );
    const child = fork(
      fileURLToPath(new URL("./backup-worker.ts", import.meta.url)),
      [
        resolve(source),
        path,
        backupId,
        ...(options.replicaDirectory
          ? [resolve(options.replicaDirectory)]
          : []),
      ],
      {
        execArgv: [
          "--import",
          import.meta.resolve("tsx"),
          "--max-old-space-size=192",
          "--max-semi-space-size=16",
        ],
        env,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
    active = child;
    const result = await new Promise<{
      bytes: number;
      snapshotRevision: number;
    }>((done, reject) => {
      let completed: { bytes: number; snapshotRevision: number } | undefined,
        failure: string | undefined;
      const fail = (code: string) => {
        failure ??= code;
        child.kill("SIGKILL");
      };
      const timer = setTimeout(() => fail("BACKUP_TIMEOUT"), timeout);
      timer.unref();
      child.on("message", (raw) => {
        if (!raw || typeof raw !== "object") {
          fail("BACKUP_WORKER_PROTOCOL");
          return;
        }
        const message = raw as Record<string, unknown>;
        if (
          message.type === "created" &&
          !created &&
          typeof message.createdAt === "string" &&
          Number.isFinite(Date.parse(message.createdAt))
        ) {
          created = true;
          try {
            onBackupCreated(message.createdAt);
          } catch {
            fail("BACKUP_WORKER_CALLBACK");
          }
        } else if (
          message.type === "phase" &&
          ((!created &&
            ["copy", "verify", "publish"].includes(String(message.phase))) ||
            (created &&
              ["retention", "replica"].includes(String(message.phase))))
        ) {
          if (message.phase === "copy") ownsScratch = true;
          enterPhase(String(message.phase));
        } else if (
          message.type === "replicated" &&
          phase === "replica" &&
          typeof message.copiedAt === "string" &&
          Number.isFinite(Date.parse(message.copiedAt)) &&
          typeof message.snapshotAt === "string" &&
          Number.isFinite(Date.parse(message.snapshotAt))
        ) {
          try {
            options.onReplicaCreated?.(message.copiedAt, message.snapshotAt);
          } catch {
            fail("BACKUP_WORKER_CALLBACK");
          }
        } else if (
          message.type === "completed" &&
          created &&
          Number.isSafeInteger(message.bytes) &&
          Number(message.bytes) > 0 &&
          Number.isSafeInteger(message.snapshotRevision)
        ) {
          completed = {
            bytes: Number(message.bytes),
            snapshotRevision: Number(message.snapshotRevision),
          };
        } else if (message.type === "failed") {
          const reported = String(message.phase);
          if (
            ["copy", "verify", "publish", "retention", "replica"].includes(
              reported,
            ) &&
            reported !== phase
          )
            enterPhase(reported);
          failure =
            phase === "replica"
              ? "BACKUP_REPLICA_FAILED"
              : "BACKUP_WORKER_FAILED";
        } else fail("BACKUP_WORKER_PROTOCOL");
      });
      child.once("error", () => fail("BACKUP_WORKER_START_FAILED"));
      child.once("close", (code) => {
        clearTimeout(timer);
        if (active === child) active = undefined;
        if (failure || code !== 0 || !completed)
          reject(new Error(failure ?? "BACKUP_WORKER_EXIT"));
        else done(completed);
      });
    });
    phaseDurations[phase] =
      (phaseDurations[phase] ?? 0) +
      Math.round(performance.now() - phaseStarted);
    console.log(
      event("backup_completed", {
        durationMs: Math.round(performance.now() - started),
        bytes: result.bytes,
        phaseDurations,
      }),
    );
    return result;
  } catch (error) {
    phaseDurations[phase] =
      (phaseDurations[phase] ?? 0) +
      Math.round(performance.now() - phaseStarted);
    const temporary = `${path}.partial-${backupId}`;
    await Promise.all(
      [
        temporary,
        temporary + ".manifest.json",
        temporary + "-wal",
        temporary + "-shm",
        temporary + "-journal",
      ].map((item) => rm(item, { force: true }).catch(() => {})),
    );
    // A killed child can leave the first final rename. Never remove an existing or complete pair.
    if (ownsTarget && !created && !(await exists(path + ".manifest.json")))
      await rm(path, { force: true }).catch(() => {});
    if (ownsScratch) {
      try {
        cleanBackupScratch(backupId);
      } catch {
        /* preserve unexpected staging contents */
      }
    }
    console.error(
      event("backup_failed", {
        durationMs: Math.round(performance.now() - started),
        phaseDurations,
        code: /^BACKUP_[A-Z_]+$/.test((error as Error).message)
          ? (error as Error).message
          : "BACKUP_WORKER_FAILED",
      }),
    );
    throw error;
  } finally {
    running = false;
  }
}
