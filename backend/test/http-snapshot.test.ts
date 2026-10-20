import { expect, it } from "vitest";
import { createSeed } from "../../shared/domain/seed";
import { readHttpSnapshot } from "../../shared/testing/http-snapshot.mjs";

it("collects all bounded pages without requesting internal or unauthorized collections", async () => {
  const paths: string[] = [];
  const snapshot = await readHttpSnapshot(async (path) => {
    paths.push(path);
    if (path.startsWith("/api/bootstrap"))
      return {
        db: createSeed(),
        sessions: {
          user: { id: "u1", role: "user", name: "Buyer" },
          admin: null,
        },
      };
    const url = new URL(path, "http://localhost");
    const page = Number(url.searchParams.get("page"));
    expect(url.searchParams.get("pageSize")).toBe("100");
    if (url.pathname.endsWith("/notifications"))
      return { items: [{ id: `notice-${page}` }], pages: 2 };
    return { items: [], pages: 1 };
  });
  expect(snapshot.db.notifications).toEqual([
    { id: "notice-1" },
    { id: "notice-2" },
  ]);
  expect(
    paths.some((path) =>
      /checkoutQuotes|orderRequests|inventoryRequests|ledger|suppliers/.test(
        path,
      ),
    ),
  ).toBe(false);
});

it("propagates collection failures instead of returning incomplete evidence", async () => {
  await expect(
    readHttpSnapshot(async (path) => {
      if (path.startsWith("/api/bootstrap"))
        return { db: createSeed(), sessions: { user: null, admin: null } };
      throw new Error("collection unavailable");
    }),
  ).rejects.toThrow("collection unavailable");
});
