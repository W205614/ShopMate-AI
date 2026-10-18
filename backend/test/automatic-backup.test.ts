import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { runAutomaticBackup } from "../src/automatic-backup";

const mocks = vi.hoisted(() => ({
  backup: vi.fn(),
  prune: vi.fn(),
  stat: vi.fn(),
}));
vi.mock("../src/maintenance", () => ({
  backupDatabase: mocks.backup,
  pruneDailyBackups: mocks.prune,
}));
vi.mock("node:fs", () => ({ statSync: mocks.stat }));

const sql = {} as DatabaseSync;
const directory = "/private-host-directory/backups";
const destination = directory + "/shopmate-daily-2026-10-18-123.sqlite";
let output: ReturnType<typeof vi.spyOn>, errors: ReturnType<typeof vi.spyOn>;
const logged = (spy: ReturnType<typeof vi.spyOn>): Record<string, unknown>[] =>
  spy.mock.calls.map(([line]: unknown[]) => JSON.parse(String(line)));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "performance"] });
  vi.setSystemTime(new Date("2026-10-18T08:00:00.000Z"));
  mocks.backup.mockReset().mockResolvedValue({});
  mocks.prune.mockReset().mockReturnValue([]);
  mocks.stat.mockReset().mockReturnValue({ size: 4096 });
  output = vi.spyOn(console, "log").mockImplementation(() => {});
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("automatic backup observability", () => {
  it("emits a correlated interval and bytes only when backup and retention finish", async () => {
    let finish!: () => void;
    const onCreated = vi.fn();
    mocks.backup.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const attempt = runAutomaticBackup(sql, destination, onCreated);
    const [started] = logged(output);
    expect(started).toEqual({
      level: "info",
      event: "backup_started",
      at: "2026-10-18T08:00:00.000Z",
      backupId: expect.any(String),
      file: "shopmate-daily-2026-10-18-123.sqlite",
    });
    expect(onCreated).not.toHaveBeenCalled();
    expect(mocks.prune).not.toHaveBeenCalled();
    vi.advanceTimersByTime(125);
    finish();
    await attempt;
    const [, completed] = logged(output);
    expect(completed).toEqual({
      ...started,
      event: "backup_completed",
      at: "2026-10-18T08:00:00.125Z",
      durationMs: 125,
      bytes: 4096,
    });
    expect(mocks.backup).toHaveBeenCalledWith(sql, destination, {
      reason: "daily",
    });
    expect(mocks.prune).toHaveBeenCalledWith(directory, 7);
    expect(onCreated).toHaveBeenCalledOnce();
    expect(errors).not.toHaveBeenCalled();
    expect(JSON.stringify(logged(output))).not.toContain(directory);
  });

  it("logs failures without exception secrets and permits a later retry with a new ID", async () => {
    const failure = new Error(
      "private-host-directory password=private-credential account-digest=secret",
    );
    const onCreated = vi.fn();
    mocks.backup.mockImplementationOnce(async () => {
      vi.advanceTimersByTime(80);
      throw failure;
    });
    await expect(runAutomaticBackup(sql, destination, onCreated)).rejects.toBe(
      failure,
    );
    expect(onCreated).not.toHaveBeenCalled();
    expect(mocks.prune).not.toHaveBeenCalled();
    const [started] = logged(output),
      [failed] = logged(errors);
    expect(failed).toEqual({
      ...started,
      level: "error",
      event: "backup_failed",
      at: "2026-10-18T08:00:00.080Z",
      durationMs: 80,
    });
    expect(JSON.stringify(failed)).not.toContain("private-credential");
    expect(JSON.stringify(failed)).not.toContain("secret");
    expect(JSON.stringify(failed)).not.toContain(directory);
    await runAutomaticBackup(sql, destination, onCreated);
    const [, retryStarted, retryCompleted] = logged(output);
    expect(retryStarted.backupId).not.toBe(started.backupId);
    expect(retryCompleted.backupId).toBe(retryStarted.backupId);
    expect(onCreated).toHaveBeenCalledOnce();
  });

  it("marks the day before retention as before, while correlating a retention failure", async () => {
    const order: string[] = [],
      onCreated = vi.fn(() => {
        order.push("created");
      });
    mocks.prune.mockImplementation(() => {
      order.push("retention");
      throw new Error("private-host-directory retention failure");
    });
    await expect(
      runAutomaticBackup(sql, destination, onCreated),
    ).rejects.toThrow("retention failure");
    expect(order).toEqual(["created", "retention"]);
    expect(logged(output).map((event) => event.event)).toEqual([
      "backup_started",
    ]);
    expect(logged(errors)[0]).toMatchObject({
      event: "backup_failed",
      backupId: logged(output)[0].backupId,
      durationMs: 0,
    });
    expect(JSON.stringify(logged(errors))).not.toContain(directory);
  });
});
