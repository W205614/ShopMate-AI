import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { openDatabase, transaction } from "../src/database";
import { createAccount } from "../src/auth";
import { createApp } from "../src/app";

if (process.env.RECONCILIATION_BENCHMARK_ALLOWED !== "1")
  throw new Error("EXPLICIT_ISOLATED_BENCHMARK_REQUIRED");
const output = resolve(
  process.env.RECONCILIATION_REPORT_DIR ?? "../.delivery/reconciliation-load",
);
await mkdir(output, { recursive: true });
const folder = await mkdtemp(join(output, "isolated-"));
const results = [];
for (const count of [1000, 10000, 50000]) {
  const sql = openDatabase(join(folder, `history-${count}.sqlite`));
  await createAccount(
    sql,
    {
      username: "benchmark",
      name: "合成核对员",
      password: "SyntheticBenchmark123!",
    },
    "admin",
  );
  transaction(sql, () => {
    const insert = sql.prepare(
      "INSERT INTO biz_orders(key,position,data) VALUES(?,?,?)",
    );
    const insertLedger = sql.prepare(
      "INSERT INTO biz_ledger(key,position,data) VALUES(?,?,?)",
    );
    const insertMovement = sql.prepare(
      "INSERT INTO biz_inventory(key,position,data) VALUES(?,?,?)",
    );
    insertMovement.run(
      "historical-opening",
      -1,
      JSON.stringify({
        id: "historical-opening",
        productId: "p01",
        skuId: "p01-s1",
        delta: count / 2,
        reason: "合成历史期初调整",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    for (let i = 0; i < count; i++) {
      const id = `history-${i}`;
      const paid = i % 2 === 0;
      insert.run(
        id,
        i,
        JSON.stringify({
          id,
          userId: "synthetic",
          status: paid ? "completed" : "cancelled",
          paidAt: paid ? "2026-01-01T00:00:00.000Z" : undefined,
          total: 1000,
          refundedAmount: 0,
          items: [
            {
              id: `${id}-line`,
              productId: "p01",
              skuId: "p01-s1",
              quantity: 1,
              total: 1000,
              refundedQuantity: 0,
            },
          ],
          address: { name: "合成地址", detail: "隔离数据", province: "上海市" },
          events: [],
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
      );
      if (paid) {
        insertLedger.run(
          `payment-${id}`,
          i,
          JSON.stringify({
            id: `payment-${id}`,
            type: "payment",
            reference: id,
            amount: 1000,
            createdAt: "2026-01-01T00:00:00.000Z",
          }),
        );
        insertMovement.run(
          `sale-${id}`,
          i,
          JSON.stringify({
            id: `sale-${id}`,
            productId: "p01",
            skuId: "p01-s1",
            delta: -1,
            reason: "合成历史销售",
            createdAt: "2026-01-01T00:00:00.000Z",
          }),
        );
      }
    }
  });
  const app = await createApp(sql, { origins: [] });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const login = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-ShopMate-Request": "1",
      },
      body: JSON.stringify({
        username: "benchmark",
        password: "SyntheticBenchmark123!",
        role: "admin",
      }),
    });
    if (!login.ok) throw new Error("BENCHMARK_LOGIN_FAILED");
    const cookie = login.headers.getSetCookie()[0]!.split(";")[0]!;
    const health: number[] = [];
    let running = true;
    const probe = (async () => {
      while (running) {
        const started = performance.now();
        const response = await fetch(`${base}/api/health`);
        if (!response.ok)
          throw new Error("HEALTH_FAILED_DURING_RECONCILIATION");
        await response.json();
        health.push(performance.now() - started);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    })();
    const started = performance.now();
    try {
      const response = await fetch(`${base}/api/admin/reconciliation`, {
        headers: { Cookie: cookie },
      });
      const report = await response.json();
      if (!response.ok || !report.balanced)
        throw new Error("RECONCILIATION_FAILED");
      const elapsedMs = Math.round(performance.now() - started);
      results.push({
        historicalOrders: count,
        historicalPayments: count / 2,
        reconciliationMs: elapsedMs,
        snapshotRevision: report.revision,
        healthSamples: health.length,
        healthMaxMs: Math.round(Math.max(...health)),
      });
    } finally {
      running = false;
      await probe;
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    sql.close();
  }
}
const report = {
  at: new Date().toISOString(),
  scope:
    "Isolated synthetic file-backed databases; health probes overlap real HTTP reconciliation. Not production capacity or payment throughput.",
  results,
};
await writeFile(join(folder, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ report: join(folder, "report.json"), ...report }));
