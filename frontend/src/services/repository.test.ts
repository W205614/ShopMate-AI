import { afterEach, expect, it, vi } from "vitest";
import {
  refreshState,
  getSession,
  getStorageIssue,
  request,
  getDatabase,
  setRouteScope,
} from "./repository";

afterEach(() => {
  vi.unstubAllGlobals();
  setRouteScope("/", {});
});
it("takes identity from the server and ignores old browser sessions", async () => {
  sessionStorage.setItem(
    "shopmate-ai:session:admin",
    JSON.stringify({ id: "admin", role: "admin" }),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          db: getDatabase(),
          sessions: { user: null, admin: null },
        }),
      ),
    ),
  );
  await refreshState();
  expect(getSession("admin")).toBeNull();
});
it("fails closed on server outages and shows a recoverable connection error", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockRejectedValue(new TypeError("network failed")),
  );
  await expect(refreshState()).rejects.toThrow("无法连接服务");
  expect(getSession("user")).toBeNull();
  expect(getStorageIssue()).toContain("无法连接服务");
});
it("uses same-origin credentials and CSRF request header for mutations", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ ok: true })));
  vi.stubGlobal("fetch", fetch);
  await request("/api/auth/logout", { role: "user" });
  expect(fetch).toHaveBeenCalledWith(
    "/api/auth/logout",
    expect.objectContaining({
      credentials: "same-origin",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-ShopMate-Request": "1",
      },
    }),
  );
});

it.each([
  "/admin/inventory",
  "/admin/coupons",
  "/admin/reviews",
  "/admin/operations",
])(
  "retains verified identity without forbidden collection reads on %s",
  async (path) => {
    setRouteScope(
      path,
      path === "/admin/operations" ? { tab: "promotions" } : {},
    );
    const session = {
      id: "restricted-finance",
      name: "财务",
      role: "admin",
      permissions: ["finance"],
    };
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          db: getDatabase(),
          sessions: { user: null, admin: session },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetch);
    await refreshState("admin");
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "/api/bootstrap?role=admin",
    ]);
    expect(getSession("admin")).toEqual(session);
    expect(getStorageIssue()).toBe("");
  },
);
