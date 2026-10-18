import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSeed } from "../../../shared/domain/seed";
const administrator = {
  id: "admin",
  name: "管理员",
  role: "admin" as const,
  permissions: ["staff", "warehouse"],
};
const snapshot = () => ({
  db: createSeed(),
  sessions: { user: null, admin: administrator },
});
const json = (data: unknown) => new Response(JSON.stringify(data));
beforeEach(() => {
  vi.resetModules();
  sessionStorage.clear();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("rejects an identity change during fingerprinting before sending the old draft", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(json(snapshot()));
  vi.stubGlobal("fetch", fetch);
  const repository = await import("./repository"),
    { commerceAction } = await import("./api");
  await repository.refreshState("admin");
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  let release!: () => Promise<void>;
  vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(
    (algorithm, data) =>
      new Promise<ArrayBuffer>((resolve) => {
        release = async () => resolve(await digest(algorithm, data));
      }),
  );
  const submission = commerceAction("saveStaff", {
    username: "old-owner-draft",
    password: "private-password",
  });
  repository.confirmSession("admin", {
    ...administrator,
    id: "different-owner",
  });
  await release();
  await expect(submission).rejects.toThrow("登录身份已变化");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(sessionStorage.getItem("shopmate:pending-commands")).toBeNull();
});

it("keeps member totals independent of the loaded page slices", async () => {
  const summary = {
    orderCount: 250,
    afterSaleCount: 30,
    couponClaimCount: 120,
    favoriteCount: 24,
    cartQuantity: 320,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValueOnce(
      json({
        db: createSeed(),
        sessions: {
          user: { id: "u1", role: "user", name: "林小满" },
          admin: null,
        },
        memberSummary: summary,
      }),
    ),
  );
  const repository = await import("./repository");
  await repository.refreshState("user");
  expect(repository.getMemberSummary()).toEqual(summary);
  expect(repository.getDatabase().orders.length).toBeLessThan(
    summary.orderCount,
  );
});

it("persists only a digest and request identity when a sensitive command has an unknown outcome", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(json(snapshot()))
    .mockRejectedValue(new TypeError("lost"));
  vi.stubGlobal("fetch", fetch);
  const repository = await import("./repository"),
    { commerceAction } = await import("./api");
  await repository.refreshState("admin");
  await expect(
    commerceAction("saveStaff", {
      username: "private-name",
      password: "private-password",
    }),
  ).rejects.toMatchObject({ outcome: "unknown" });
  const raw = sessionStorage.getItem("shopmate:pending-commands")!;
  expect(raw).not.toContain("private-name");
  expect(raw).not.toContain("private-password");
  const [pending] = JSON.parse(raw);
  expect(pending.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(pending.method).toBe("saveStaff");
  expect(pending.requestId).toBe(
    JSON.parse(fetch.mock.calls[1]![1].body).requestId,
  );
});

it("persists a real slow staff-password fingerprint rather than an offline fast verifier", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(json(snapshot()))
    .mockRejectedValue(new TypeError("lost"));
  vi.stubGlobal("fetch", fetch);
  const repository = await import("./repository"),
    { commerceAction } = await import("./api");
  await repository.refreshState("admin");
  const input = { username: "private-name", password: "private-password" },
    encoder = new TextEncoder(),
    fast = await crypto.subtle.digest(
      "SHA-256",
      encoder.encode(
        JSON.stringify(["admin", administrator.id, "saveStaff", [input]]),
      ),
    ),
    hex = (bytes: ArrayBuffer) =>
      Array.from(new Uint8Array(bytes), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join(""),
    derivation = vi.spyOn(crypto.subtle, "deriveBits");
  await expect(commerceAction("saveStaff", input)).rejects.toMatchObject({
    outcome: "unknown",
  });
  const raw = sessionStorage.getItem("shopmate:pending-commands")!,
    [pending] = JSON.parse(raw);
  expect(pending.fingerprint).not.toBe(hex(fast));
  expect(raw).not.toContain(hex(fast));
  expect(raw).not.toContain(input.password);
  expect(derivation).toHaveBeenCalledTimes(1);
  const parameters = derivation.mock.calls[0]![0] as Pbkdf2Params;
  expect(parameters).toMatchObject({
    name: "PBKDF2",
    hash: "SHA-256",
    iterations: 600_000,
  });
  expect(derivation.mock.calls[0]![2]).toBe(256);
  const key = await crypto.subtle.importKey("raw", fast, "PBKDF2", false, [
      "deriveBits",
    ]),
    expected = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        iterations: 600_000,
        salt: encoder.encode(
          JSON.stringify([
            "shopmate:pending-command:v2",
            "admin",
            administrator.id,
            "saveStaff",
          ]),
        ),
      },
      key,
      256,
    );
  expect(pending.fingerprint).toBe(hex(expected));
});

it("resolves a lost response before retrying and never sends the completed command twice", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(json(snapshot()))
    .mockRejectedValueOnce(new TypeError("response lost"))
    .mockResolvedValueOnce(json(snapshot()))
    .mockResolvedValueOnce(json({ found: true, result: "saved-on-server" }))
    .mockResolvedValueOnce(json(snapshot()));
  vi.stubGlobal("fetch", fetch);
  const repository = await import("./repository"),
    { commerceAction } = await import("./api");
  await repository.refreshState("admin");
  await expect(
    commerceAction("saveSupplier", { name: "supplier" }),
  ).rejects.toThrow();
  await repository.refreshState("admin");
  await expect(
    commerceAction("saveSupplier", { name: "supplier" }),
  ).resolves.toBe("saved-on-server");
  expect(
    fetch.mock.calls.filter(([, init]) => init?.method === "POST"),
  ).toHaveLength(1);
  expect(fetch.mock.calls[3]![0]).toContain("/api/requests/");
  expect(
    JSON.parse(sessionStorage.getItem("shopmate:pending-commands")!),
  ).toEqual([]);
});

it("loads only the requested domain page and retains its metadata when loading related records", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(json(snapshot()))
    .mockResolvedValueOnce(
      json({
        items: [{ id: "order-11" }],
        total: 25,
        page: 2,
        pageSize: 10,
        pages: 3,
        revision: 1,
        related: { products: [{ id: "linked-product" }] },
      }),
    );
  vi.stubGlobal("fetch", fetch);
  const repository = await import("./repository");
  repository.setRouteScope("/admin/orders", { page: "2", q: "paid item" });
  await repository.refreshState("admin");
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[0]![0]).toBe("/api/bootstrap?role=admin");
  const url = new URL(fetch.mock.calls[1]![0], "http://localhost");
  expect(url.pathname).toBe("/api/collections/orders");
  expect(url.searchParams.get("page")).toBe("2");
  expect(url.searchParams.get("search")).toBe("paid item");
  expect(repository.getCollectionPage("orders")).toMatchObject({
    total: 25,
    page: 2,
    pages: 3,
  });
  expect(repository.getDatabase().orders.map((order) => order.id)).toEqual([
    "order-11",
  ]);
  expect(
    repository.getDatabase().products.map((product) => product.id),
  ).toEqual(["linked-product"]);
});

it("clears a private snapshot when bootstrap confirms expiry without querying a protected collection", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(json(snapshot()))
      .mockResolvedValueOnce(
        json({
          db: { settings: createSeed().settings },
          sessions: { user: null, admin: null },
        }),
      ),
  );
  const repository = await import("./repository");
  await repository.refreshState("admin");
  repository.setRouteScope("/admin/orders", {});
  await repository.refreshState("admin");
  expect(repository.getSession("admin")).toBeNull();
  expect(repository.getDatabase().orders).toEqual([]);
  expect(repository.getSyncStatus().phase).toBe("ready");
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("blocks a changed payload while an earlier command outcome remains unknown", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(json(snapshot()))
    .mockRejectedValueOnce(new TypeError("lost"))
    .mockResolvedValueOnce(json(snapshot()))
    .mockResolvedValueOnce(json({ found: false }));
  vi.stubGlobal("fetch", fetch);
  const repository = await import("./repository"),
    { commerceAction } = await import("./api");
  await repository.refreshState("admin");
  await expect(
    commerceAction("createPurchaseOrder", { quantity: 1 }),
  ).rejects.toThrow();
  await repository.refreshState("admin");
  await expect(
    commerceAction("createPurchaseOrder", { quantity: 2 }),
  ).rejects.toThrow("不能更改参数");
  expect(
    fetch.mock.calls.filter(([, init]) => init?.method === "POST"),
  ).toHaveLength(1);
});

it("concurrent quote updates remain independent and preserve each pending recovery marker", async () => {
  let finishSupplier!: (response: Response) => void,
    finishPromotion!: (response: Response) => void;
  const fetch = vi
    .fn()
    .mockImplementation((url: string, init?: RequestInit) => {
      const name = init?.body
        ? JSON.parse(String(init.body)).args[0]?.name
        : undefined;
      if (url.includes("/api/actions/quoteCheckout") && name === "A")
        return new Promise<Response>((resolve) => {
          finishSupplier = resolve;
        });
      if (url.includes("/api/actions/quoteCheckout") && name === "B")
        return new Promise<Response>((resolve) => {
          finishPromotion = resolve;
        });
      return Promise.resolve(json(snapshot()));
    });
  vi.stubGlobal("fetch", fetch);
  const repository = await import("./repository"),
    { commerceAction } = await import("./api");
  await repository.refreshState("admin");
  const supplier = commerceAction("quoteCheckout", { name: "A" });
  await vi.waitFor(() => expect(finishSupplier).toBeDefined());
  const promotion = commerceAction("quoteCheckout", { name: "B" });
  await vi.waitFor(() => expect(finishPromotion).toBeDefined());
  finishSupplier(json({ result: "supplier-a" }));
  await supplier;
  expect(
    JSON.parse(sessionStorage.getItem("shopmate:pending-commands")!),
  ).toMatchObject([{ method: "quoteCheckout" }]);
  finishPromotion(json({ result: "promotion-b" }));
  await promotion;
  expect(
    JSON.parse(sessionStorage.getItem("shopmate:pending-commands")!),
  ).toEqual([]);
});

it("clears the generic checkout marker when the original order lookup confirms success", async () => {
  const userSnapshot = {
    ...snapshot(),
    sessions: { user: { id: "u1", role: "user", name: "林小满" }, admin: null },
  };
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(json(userSnapshot))
    .mockRejectedValueOnce(new TypeError("response lost"))
    .mockResolvedValueOnce(json({ orderId: "confirmed-order" }));
  vi.stubGlobal("fetch", fetch);
  const repository = await import("./repository"),
    { api } = await import("./api");
  await repository.refreshState("user");
  const input = { quoteId: "quote-1", requestId: "checkout-request-1" };
  await expect(api.createOrder(input)).rejects.toThrow();
  expect(
    JSON.parse(sessionStorage.getItem("shopmate:pending-commands")!),
  ).toMatchObject([{ method: "createOrder", requestId: input.requestId }]);
  await expect(api.resolveOrderRequest(input)).resolves.toBe("confirmed-order");
  expect(
    JSON.parse(sessionStorage.getItem("shopmate:pending-commands")!),
  ).toEqual([]);
});
