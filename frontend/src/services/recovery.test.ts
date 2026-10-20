import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSeed } from "../../../shared/domain/seed";

let repository: typeof import("./repository");
const user = { id: "u1", name: "林小满", role: "user" as const };
const administrator = { id: "admin", name: "管理员", role: "admin" as const };
const state = () => ({
  db: createSeed(),
  sessions: { user, admin: administrator },
});
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  repository = await import("./repository");
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("retains a same-role verified snapshot on outages and clears it before a role switch", async () => {
  const snapshot = state();
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(json(snapshot))
      .mockRejectedValue(new TypeError("offline")),
  );
  await repository.refreshState("admin");
  await expect(repository.refreshState("admin")).rejects.toThrow();
  expect(repository.getSession("admin")).toEqual(administrator);
  expect(repository.getDatabase().ledger).toEqual(snapshot.db.ledger);
  expect(repository.getSyncStatus().phase).toBe("stale");
  await expect(repository.refreshState("user")).rejects.toThrow();
  expect(repository.getDatabase().orders).toEqual([]);
  expect(repository.getDatabase().ledger).toEqual([]);
  expect(repository.getSyncStatus().phase).toBe("unavailable");
});

it("does not pretend a malformed successful write response is a successful result", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response("not json", { status: 200 })),
  );
  await expect(
    repository.request("/api/actions/saveSettings", { args: [] }),
  ).rejects.toMatchObject({ outcome: "unknown" });
  await expect(repository.request("/api/bootstrap")).rejects.toMatchObject({
    outcome: "read-failed",
  });
});

it("returns a confirmed mutation result even when subsequent state synchronization fails", async () => {
  const snapshot = state();
  const result = {
    settings: { ...snapshot.db.settings, name: "已保存" },
    revision: 2,
  };
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(json(snapshot))
    .mockResolvedValueOnce(json({ result }))
    .mockRejectedValue(new TypeError("offline"));
  vi.stubGlobal("fetch", fetch);
  await repository.refreshState("admin");
  const { api } = await import("./api");
  await expect(
    api.saveSettings(result.settings, snapshot.db.settings),
  ).resolves.toEqual(result);
  expect(
    fetch.mock.calls.filter(([, init]) => init?.method === "POST"),
  ).toHaveLength(1);
  expect(repository.getStorageIssue()).toContain("操作已完成");
  expect(repository.getSyncStatus().phase).toBe("stale");
});

it("invalidates old polling responses after a confirmed logout even when resync fails", async () => {
  let deliver!: (response: Response) => void;
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(json(state()))
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          deliver = resolve;
        }),
    )
    .mockResolvedValueOnce(json({ ok: true }))
    .mockRejectedValue(new TypeError("offline"));
  vi.stubGlobal("fetch", fetch);
  await repository.refreshState("user");
  const old = repository.refreshState("user");
  const { api } = await import("./api");
  await api.logout("user");
  deliver(json(state()));
  await old;
  expect(repository.getSession("user")).toBeNull();
  expect(repository.getSession("admin")).toEqual(administrator);
  expect(repository.getDatabase().orders).toEqual([]);
});

it("preserves explicit server rejections and labels interrupted writes as unknown without resending", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(json({ message: "没有权限" }, 403))
    .mockRejectedValue(new TypeError("connection reset"));
  vi.stubGlobal("fetch", fetch);
  await expect(
    repository.request("/api/actions/test", {}),
  ).rejects.toMatchObject({
    outcome: "rejected",
    message: "没有权限",
    status: 403,
  });
  await expect(
    repository.request("/api/actions/test", {}),
  ).rejects.toMatchObject({ outcome: "unknown" });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("uses the confirmed new account identity and clears the previous account snapshot before failed synchronization", async () => {
  const next = { id: "u2", name: "陈一禾", role: "user" as const };
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(json(state()))
      .mockResolvedValueOnce(json(next))
      .mockRejectedValue(new TypeError("offline")),
  );
  await repository.refreshState("user");
  const { api } = await import("./api");
  await expect(api.login("user", "chen", "password")).resolves.toEqual(next);
  expect(repository.getSession("user")).toEqual(next);
  expect(repository.getDatabase().orders).toEqual([]);
  expect(repository.getDatabase().addresses).toEqual([]);
  expect(repository.getSession("admin")).toEqual(administrator);
  expect(repository.getSyncStatus().phase).toBe("unavailable");
});

it("a rejected login cannot clear an independently verified active session", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(json(state()))
      .mockResolvedValueOnce(json({ message: "账号或密码错误" }, 401))
      .mockResolvedValueOnce(json(state())),
  );
  await repository.refreshState("user");
  const { api } = await import("./api");
  await expect(api.login("user", "lin", "wrong")).rejects.toThrow(
    "账号或密码错误",
  );
  expect(repository.getSession("user")).toEqual(user);
  expect(repository.getSession("admin")).toEqual(administrator);
});

it("an unknown account-switch response cannot leave the old private snapshot available", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(json(state()))
      .mockRejectedValue(new TypeError("response lost")),
  );
  await repository.refreshState("user");
  const { api } = await import("./api");
  await expect(api.login("user", "chen", "password")).rejects.toMatchObject({
    outcome: "unknown",
  });
  expect(repository.getSyncStatus().phase).toBe("unavailable");
  expect(repository.getDatabase().users).toEqual([]);
  expect(repository.getDatabase().orders).toEqual([]);
  expect(repository.getSession("admin")).toEqual(administrator);
});

it("a new unknown login invalidates an earlier confirmed logout verdict", async () => {
  repository.confirmSession("user", null);
  expect(repository.hasConfirmedLogout("user")).toBe(true);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockRejectedValue(new TypeError("response lost")),
  );
  const { api } = await import("./api");
  await expect(api.login("user", "chen", "password")).rejects.toMatchObject({
    outcome: "unknown",
  });
  expect(repository.hasConfirmedLogout("user")).toBe(false);
  expect(repository.getSyncStatus().phase).toBe("unavailable");
});
