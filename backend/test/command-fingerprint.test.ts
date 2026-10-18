import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type { Server } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { createApp } from "../src/app";
import { commandFingerprint, tokenHash } from "../src/auth";
import { openDatabase } from "../src/database";

let sql: DatabaseSync, server: Server, base: string;
beforeEach(async () => {
  sql = openDatabase(":memory:");
  sql
    .prepare("INSERT INTO accounts VALUES(?,?,?,?,?,?)")
    .run("owner", "owner", "店主", "admin", "unused-test-hash", Date.now());
  sql
    .prepare("INSERT INTO sessions VALUES(?,?,?)")
    .run(tokenHash("owner-test-token"), "owner", Date.now() + 60000);
  const app = await createApp(sql, { origins: ["http://localhost"] });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  sql.close();
});

describe("password-bearing command fingerprints", () => {
  it("serializes concurrent retries once with a slow verifier and rejects changed credentials", async () => {
    const requestId = "concurrent-staff-create";
    const args = [
      {
        username: "warehouse_worker",
        name: "仓库员工",
        password: "WorkerPass123!",
        staffRole: "warehouse",
        active: true,
      },
    ];
    const send = (input = args) =>
      fetch(base + "/api/actions/saveStaff", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-ShopMate-Request": "1",
          Cookie: "shopmate_admin=owner-test-token",
        },
        body: JSON.stringify({ args: input, requestId }),
      });
    const replies = await Promise.all([send(), send()]);
    expect(replies.map((reply) => reply.status)).toEqual([200, 200]);
    const bodies = await Promise.all(replies.map((reply) => reply.json()));
    expect(bodies[0].result.id).toBeTruthy();
    expect(bodies[1].result).toEqual(bodies[0].result);
    expect(
      sql
        .prepare("SELECT count(*) AS n FROM accounts WHERE username=?")
        .get("warehouse_worker")?.n,
    ).toBe(1);
    expect(
      sql
        .prepare(
          "SELECT count(*) AS n FROM operation_audit WHERE action='saveStaff' AND request_id=? AND result='completed'",
        )
        .get(requestId)?.n,
    ).toBe(1);

    const stored = sql
      .prepare(
        "SELECT fingerprint FROM command_results WHERE actor_id='owner' AND method='saveStaff' AND request_id=?",
      )
      .get(requestId) as { fingerprint: string };
    const salt = createHash("sha256")
      .update(JSON.stringify(["owner", "saveStaff", requestId]))
      .digest("hex")
      .slice(0, 32);
    expect(stored.fingerprint).toMatch(
      /^scrypt-command-v1\$[a-f0-9]{32}\$[a-f0-9]{128}$/,
    );
    expect(stored.fingerprint.split("$")[1]).toBe(salt);
    expect(stored.fingerprint).not.toBe(
      createHash("sha256").update(JSON.stringify(args)).digest("hex"),
    );
    expect(stored.fingerprint.includes(args[0]!.password)).toBe(false);

    const conflict = await send([
      { ...args[0]!, password: "DifferentPass456!" },
    ]);
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).code).toBe("IDEMPOTENCY_CONFLICT");
    expect(
      sql
        .prepare("SELECT count(*) AS n FROM accounts WHERE username=?")
        .get("warehouse_worker")?.n,
    ).toBe(1);
    expect(
      sql
        .prepare(
          "SELECT fingerprint FROM command_results WHERE actor_id='owner' AND method='saveStaff' AND request_id=?",
        )
        .get(requestId)?.fingerprint,
    ).toBe(stored.fingerprint);
  }, 30000);

  it("keeps ordinary commands and staff edits without passwords on the fast digest", async () => {
    for (const [method, args] of [
      ["saveSupplier", [{ name: "供货商", active: true }]],
      ["saveStaff", [{ id: "worker", name: "员工", active: true }]],
    ] as const) {
      const input = [...args];
      expect(await commandFingerprint("owner", method, "ordinary", input)).toBe(
        createHash("sha256").update(JSON.stringify(input)).digest("hex"),
      );
    }
  });
});
