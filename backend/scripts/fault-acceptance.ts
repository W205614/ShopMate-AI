/**
 * Isolated destructive acceptance. Requires an API published only on localhost:18090
 * and a Docker container labelled shopmate.acceptance=fault. Never targets daily stacks.
 * FAULT_MUTATIONS_ALLOWED=1 FAULT_CONTAINER=... FAULT_ADMIN_PASSWORD=... node --import tsx scripts/fault-acceptance.ts
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { request as httpRequest } from "node:http";
import type {
  Address,
  AfterSale,
  CheckoutQuote,
  LedgerEntry,
  Order,
  Product,
} from "../../shared/domain/types";

const execute = promisify(execFile);
const base = process.env.FAULT_BASE_URL ?? "http://127.0.0.1:18090";
const container = process.env.FAULT_CONTAINER;
const adminPassword = process.env.FAULT_ADMIN_PASSWORD;
assert.equal(
  process.env.FAULT_MUTATIONS_ALLOWED,
  "1",
  "Explicit isolated mutation opt-in required",
);
assert.equal(
  base,
  "http://127.0.0.1:18090",
  "Only isolated port 18090 is permitted",
);
assert(
  container && /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(container),
  "Exact fault container required",
);
assert(adminPassword, "Fault admin password required");
const reportPath = resolve(
  process.env.FAULT_REPORT_PATH ?? "../.delivery/fault-acceptance.json",
);
const startedAt = new Date().toISOString();
const stages: Record<string, unknown> = {};
const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
const docker = (...args: string[]) =>
  execute("docker", args, { maxBuffer: 1024 * 1024 });
async function inspect() {
  const info = JSON.parse((await docker("inspect", container!)).stdout)[0];
  assert.equal(
    info.Config.Labels?.["shopmate.acceptance"],
    "fault",
    "Fault-only label missing",
  );
  const project = info.Config.Labels?.["com.docker.compose.project"];
  assert(
    typeof project === "string" && project.length > 0,
    "Fault Compose project required",
  );
  const ids = (
    await docker(
      "ps",
      "--filter",
      `label=com.docker.compose.project=${project}`,
      "--format",
      "{{.ID}}",
    )
  ).stdout
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const peers = JSON.parse((await docker("inspect", ...ids)).stdout);
  assert(
    peers.some(
      (peer: any) =>
        peer.Config.Labels?.["com.docker.compose.project"] === project &&
        peer.Config.Labels?.["com.docker.compose.service"] === "web" &&
        Object.values(peer.NetworkSettings.Ports ?? {})
          .flat()
          .some(
            (port: any) =>
              port?.HostIp === "127.0.0.1" && port?.HostPort === "18090",
          ),
    ),
    "The same labelled fault project must own localhost web port 18090",
  );
  return info;
}
class Client {
  cookie = "";
  async response(path: string, body?: unknown) {
    const response = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        "X-ShopMate-Request": "1",
        Cookie: this.cookie,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(45000),
    });
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    if (cookie) this.cookie = cookie;
    return response;
  }
  async json<T = any>(path: string, body?: unknown): Promise<T> {
    const response = await this.response(path, body);
    const value = await response.json();
    assert(
      response.ok,
      `${path}: HTTP ${response.status}: ${JSON.stringify(value)}`,
    );
    return value as T;
  }
  async action<T = void>(
    method: string,
    args: unknown[],
    requestId = randomUUID(),
  ): Promise<T> {
    return (
      await this.json<{ result: T }>(`/api/actions/${method}`, {
        args,
        requestId,
      })
    ).result;
  }
  async items<T>(
    name: string,
    role: "admin" | "user",
    query = "",
  ): Promise<T[]> {
    return (
      await this.json<{ items: T[] }>(
        `/api/collections/${name}?role=${role}&pageSize=100${query}`,
      )
    ).items;
  }
}
async function healthy() {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      if (
        (
          await fetch(base + "/api/health", {
            signal: AbortSignal.timeout(1500),
          })
        ).ok
      )
        return;
    } catch {
      /* starting */
    }
    await pause(500);
  }
  throw new Error("Fault API did not recover within 60 seconds");
}
function holder(code: string, marker: string) {
  const child = spawn(
    "docker",
    ["exec", container!, "node", "--input-type=module", "-e", code],
    { windowsHide: true },
  );
  let output = "";
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
      if (output.includes(marker)) resolve();
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (!output.includes(marker))
        reject(new Error(`Fault holder exited ${code}: ${output}`));
    });
  });
  const closed = new Promise<number | null>((resolve) =>
    child.once("exit", resolve),
  );
  return { ready, closed };
}
async function discardCommittedResponse(
  client: Client,
  method: string,
  args: unknown[],
  requestId: string,
) {
  // Receiving response headers proves server commit completed; discard the body to simulate an unknown result.
  await new Promise<void>((resolve, reject) => {
    const request = httpRequest(
      base + `/api/actions/${method}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-ShopMate-Request": "1",
          Cookie: client.cookie,
        },
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(
            new Error(`Lost response action failed: ${response.statusCode}`),
          );
          return;
        }
        response.destroy();
        resolve();
      },
    );
    request.once("error", reject);
    request.end(JSON.stringify({ args, requestId }));
  });
}
async function main() {
  const before = await inspect();
  await healthy();
  const admin = new Client(),
    user = new Client(),
    other = new Client();
  await admin.json("/api/auth/login", {
    username: "admin",
    password: adminPassword,
    role: "admin",
  });
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  await user.json("/api/auth/register", {
    username: `fault_${suffix}`,
    name: "故障验收买家",
    password: "FaultAcceptance123!",
  });
  await other.json("/api/auth/register", {
    username: `other_${suffix}`,
    name: "隔离身份",
    password: "FaultAcceptance123!",
  });
  await user.action("saveAddress", [
    {
      name: "故障验收",
      phone: "13800000000",
      province: "上海市",
      region: "上海市 浦东新区",
      detail: "隔离环境虚构地址",
      isDefault: true,
    },
  ]);
  const address = (await user.items<Address>("addresses", "user"))[0]!;
  const category = (
    await admin.items<{ id: string }>("categories", "admin")
  )[0]!;
  const productName = `fault-${suffix}`;
  await admin.action("saveProduct", [
    {
      name: productName,
      subtitle: "隔离热点库存",
      description: "仅用于隔离故障验收",
      material: "模拟",
      categoryId: category.id,
      images: ["/images/p01.jpg"],
      active: true,
      featured: false,
      version: 0,
      skus: [{ id: "new", name: "热点规格", price: 101, stock: 10 }],
    },
  ]);
  const product = (
    await admin.items<Product>("products", "admin", `&q=${productName}`)
  )[0]!;
  const sku = product.skus[0]!;
  const quote = () =>
    user.action<CheckoutQuote>("quoteCheckout", [
      {
        source: {
          type: "buyNow",
          productId: product.id,
          skuId: sku.id,
          quantity: 1,
        },
        addressId: address.id,
      },
    ]);
  const quoteResults = await Promise.all(Array.from({ length: 50 }, quote));
  const createResults = await Promise.all(
    quoteResults.map((q) =>
      user.response("/api/actions/createOrder", {
        args: [{ quoteId: q.id, requestId: randomUUID() }],
        requestId: randomUUID(),
      }),
    ),
  );
  const statuses = createResults.map((r) => r.status);
  assert.equal(
    statuses.filter((s) => s === 200).length,
    10,
    "Exactly ten units can be reserved",
  );
  assert(
    statuses.every((s) => s === 200 || s === 400 || s === 429),
    `Unexpected hotspot statuses: ${statuses}`,
  );
  const orderIds: string[] = [];
  for (const response of createResults)
    if (response.status === 200) orderIds.push((await response.json()).result);
  const publicStock = (
    await user.items<Product>("products", "user", `&id=${product.id}`)
  )[0]!.skus[0]!.stock;
  assert.equal(publicStock, 0);
  stages.hotspot = {
    concurrent: 50,
    statuses: Object.fromEntries(
      [...new Set(statuses)].map((s) => [
        s,
        statuses.filter((v) => v === s).length,
      ]),
    ),
    reservedOrders: orderIds.length,
    availableStock: publicStock,
  };
  console.log("hotspot: passed");

  const orderId = orderIds[0]!,
    paymentKey = randomUUID();
  await Promise.all(
    Array.from({ length: 50 }, () =>
      user.action("payOrder", [orderId], paymentKey),
    ),
  );
  for (const pendingId of orderIds.slice(1))
    await user.action("cancelOrder", [pendingId]);
  const order = (
    await user.items<Order>("orders", "user", `&id=${orderId}`)
  )[0]!;
  await user.action("requestAfterSale", [
    orderId,
    "隔离退款",
    "重复请求不能重复记账",
    [{ orderItemId: order.items[0]!.id, quantity: 1 }],
  ]);
  const sale = (
    await user.items<AfterSale>("afterSales", "user", `&orderId=${orderId}`)
  )[0]!;
  await admin.action("processAfterSale", [sale.id, "approve"]);
  const refundKey = randomUUID();
  await Promise.all(
    Array.from({ length: 50 }, () =>
      admin.action("processAfterSale", [sale.id, "refund"], refundKey),
    ),
  );
  const ledger = await admin.items<LedgerEntry>(
    "ledger",
    "admin",
    `&q=${orderId}`,
  );
  assert.equal(
    ledger.filter((e) => e.type === "payment" && e.reference === orderId)
      .length,
    1,
  );
  assert.equal(
    ledger.filter((e) => e.type === "refund" && e.reference === orderId).length,
    1,
  );
  assert.equal(
    (await other.json(`/api/requests/${paymentKey}?method=payOrder`)).found,
    false,
  );
  const afterRefund = (
    await admin.items<Product>("products", "admin", `&id=${product.id}`)
  )[0]!.skus[0]!.stock;
  assert.equal(afterRefund, 10);
  stages.replay = {
    paymentRequests: 50,
    paymentEntries: 1,
    refundRequests: 50,
    refundEntries: 1,
    restoredStock: afterRefund,
    foreignRequestVisible: false,
  };
  console.log("replay and identity isolation: passed");

  const q = await quote(),
    lostKey = randomUUID(),
    creation = { quoteId: q.id, requestId: randomUUID() };
  await discardCommittedResponse(user, "createOrder", [creation], lostKey);
  const recoveredBefore = await user.json<{ found: boolean; result: string }>(
    `/api/requests/${lostKey}?method=createOrder`,
  );
  assert(recoveredBefore.found);
  const crashMarker = `uncommitted-${suffix}`;
  const crash = holder(
    `import {DatabaseSync} from 'node:sqlite';const d=new DatabaseSync(process.env.DATABASE_PATH);d.exec('BEGIN IMMEDIATE');d.prepare('INSERT INTO operation_audit VALUES (?,?,?,?,?,?,?)').run(${JSON.stringify(crashMarker)},'fault','uncommitted','fault',null,'must-rollback',new Date().toISOString());console.log('TRANSACTION_OPEN');setInterval(()=>{},1000);`,
    "TRANSACTION_OPEN",
  );
  await crash.ready;
  await docker("kill", "--signal", "KILL", container!);
  await crash.closed;
  await docker("start", container!);
  await healthy();
  const recoveredAfter = await user.json<{ found: boolean; result: string }>(
    `/api/requests/${lostKey}?method=createOrder`,
  );
  assert.deepEqual(recoveredAfter, recoveredBefore);
  assert.equal(
    await user.action<string>("createOrder", [creation], lostKey),
    recoveredBefore.result,
  );
  const check = await docker(
    "exec",
    container!,
    "node",
    "--input-type=module",
    "-e",
    `import {DatabaseSync} from 'node:sqlite';const d=new DatabaseSync(process.env.DATABASE_PATH);console.log(JSON.stringify({integrity:d.prepare('PRAGMA integrity_check').get(),uncommitted:d.prepare('SELECT count(*) AS n FROM operation_audit WHERE id=?').get(${JSON.stringify(crashMarker)})}));d.close();`,
  );
  const crashState = JSON.parse(check.stdout.trim());
  assert.equal(crashState.integrity.integrity_check, "ok");
  assert.equal(crashState.uncommitted.n, 0);
  stages.crash = {
    lostResponseRecovered: true,
    replayOrderId: recoveredAfter.result,
    committedResultSurvivesKill: true,
    uncommittedTransactionRolledBack: true,
    integrity: "ok",
  };
  console.log("lost response and process kill recovery: passed");

  const lock = holder(
    "import {DatabaseSync} from 'node:sqlite';const d=new DatabaseSync(process.env.DATABASE_PATH);d.exec('BEGIN IMMEDIATE');console.log('LOCK_HELD');setTimeout(()=>{d.exec('ROLLBACK');d.close();},18000);",
    "LOCK_HELD",
  );
  await lock.ready;
  const lockKey = randomUUID();
  const lockRequestStarted = performance.now();
  const blocked = await user.response("/api/actions/favorite", {
    args: [product.id, true],
    requestId: lockKey,
  });
  const blockedBody = await blocked.json();
  const lockWaitMs = Math.round(performance.now() - lockRequestStarted);
  await lock.closed;
  assert.equal(blocked.status, 503, JSON.stringify(blockedBody));
  assert.equal(blockedBody.code, "DATABASE_BUSY");
  await user.action("favorite", [product.id, true], lockKey);
  stages.lock = {
    waitMs: lockWaitMs,
    status: blocked.status,
    code: blockedBody.code,
    originalRequestRetrySucceeded: true,
  };
  console.log("SQL writer lock: passed");

  const overload = await Promise.all(
    Array.from({ length: 50 }, (_, i) =>
      new Client().response("/api/auth/login", {
        username: `absent_${suffix}_${i}`,
        password: "Incorrect123!",
        role: "user",
      }),
    ),
  );
  const authStatuses = overload.map((r) => r.status);
  assert(
    authStatuses.includes(429),
    "Bounded hashing queue must reject overload",
  );
  assert(
    authStatuses.every((s) => s === 401 || s === 429),
    `Unexpected auth status: ${authStatuses}`,
  );
  await healthy();
  const after = await inspect();
  assert.equal(after.State.OOMKilled, false);
  const reconciliation = await admin.json("/api/admin/reconciliation");
  assert.equal(
    reconciliation.balanced,
    true,
    JSON.stringify(reconciliation.issues),
  );
  stages.authentication = {
    concurrent: 50,
    statuses: Object.fromEntries(
      [...new Set(authStatuses)].map((s) => [
        s,
        authStatuses.filter((v) => v === s).length,
      ]),
    ),
    oomKilled: false,
    healthyAfter: true,
  };
  stages.final = {
    reconciliationBalanced: true,
    containerId: after.Id,
    imageId: after.Image,
    initialImageId: before.Image,
  };
  console.log("authentication overload and final reconciliation: passed");
}
try {
  await main();
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        passed: true,
        base,
        startedAt,
        completedAt: new Date().toISOString(),
        stages,
      },
      null,
      2,
    ),
  );
  console.log(`fault acceptance passed: ${reportPath}`);
} catch (error) {
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        passed: false,
        base,
        startedAt,
        completedAt: new Date().toISOString(),
        stages,
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ),
  );
  throw error;
}
