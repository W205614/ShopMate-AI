import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { HttpError } from "./errors";
import { reconcile } from "./reconciliation";

export function createReconciliationReader(sql: DatabaseSync) {
  let running: Promise<ReturnType<typeof reconcile>> | undefined;
  return () => {
    if (running) return running;
    const source = sql.location();
    // In-memory HTTP fixtures have no file to share. Deployed databases always use the child.
    if (!source) return Promise.resolve(reconcile(sql));
    running = new Promise<ReturnType<typeof reconcile>>((resolve, reject) => {
      const child = fork(
        fileURLToPath(new URL("./reconciliation-worker.ts", import.meta.url)),
        [source],
        {
          execArgv: [
            "--import",
            import.meta.resolve("tsx"),
            "--max-old-space-size=192",
          ],
          env: Object.fromEntries(
            Object.entries(process.env).filter(([key]) =>
              ["PATH", "Path", "SystemRoot", "TEMP", "TMP", "TZ"].includes(key),
            ),
          ),
          windowsHide: true,
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        },
      );
      let result: ReturnType<typeof reconcile> | undefined;
      const timer = setTimeout(() => child.kill("SIGKILL"), 12000);
      timer.unref();
      child.once(
        "message",
        (message: { result: ReturnType<typeof reconcile> }) => {
          result = message.result;
        },
      );
      child.once("error", () => {
        clearTimeout(timer);
        reject(
          new HttpError(
            503,
            "财务核对进程无法启动，请稍后重新核对",
            "RECONCILIATION_FAILED",
          ),
        );
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (code === 0 && result) resolve(result);
        else
          reject(
            new HttpError(
              503,
              "财务核对未完成，请稍后重新核对",
              "RECONCILIATION_FAILED",
            ),
          );
      });
    }).finally(() => {
      running = undefined;
    });
    return running;
  };
}
