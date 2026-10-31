/** Real HTTP quality matrix; the live profile is deliberately limited to 12 cases. */
import { readHttpSnapshot } from "../../shared/testing/http-snapshot.mjs";
import { qualityCases, knowledgeDocuments, evaluateQualityCase, summarizeQuality, budgetRecommendationCheck, answerHasAmount } from "./ai-quality-cases.mjs";
import { holdoutCases } from "./ai-quality-holdout.mjs";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const base = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:18092";
const mode = process.env.AI_QUALITY_MODE ?? "live";
const suite = process.env.AI_QUALITY_SUITE ?? "contract";
if (!["contract", "holdout"].includes(suite)) throw Error("INVALID_QUALITY_SUITE");
const providerKind = mode === "live" ? "real" : "synthetic";
const container = process.env.AI_ACCEPTANCE_CONTAINER;
const proxy = process.env.AI_ACCEPTANCE_PROXY_URL;
const token = process.env.AI_ACCEPTANCE_PROXY_TOKEN;
if (process.env.AI_ACCEPTANCE_ALLOWED !== "1" || !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(base) || new URL(base).port === "18086" ||
  !["live", "matrix"].includes(mode) || !/^shopmate-[a-z0-9-]+-api-1$/.test(container ?? ""))
  throw Error("EXPLICIT_ISOLATED_QUALITY_DEPLOYMENT_REQUIRED");
const { stdout: inspected } = await exec("docker", ["inspect", container], { maxBuffer: 1_000_000 });
const info = JSON.parse(inspected)[0], env = Object.fromEntries(info.Config.Env.map((v) => [v.slice(0, v.indexOf("=")), v.slice(v.indexOf("=") + 1)]));
if (!info.Config.Labels["shopmate.acceptance"] || info.Config.Labels["com.docker.compose.project"] === "shopmate-ai")
  throw Error("ACCEPTANCE_CONTAINER_LABEL_REQUIRED");
if (mode === "live") {
  if (!token || token.length < 24 || !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(proxy ?? "")) throw Error("BOUNDED_ACCEPTANCE_PROXY_REQUIRED");
  for (const [urlKey, keyKey] of [["LLM_BASE_URL", "LLM_API_KEY"], ["EMBEDDING_BASE_URL", "EMBEDDING_API_KEY"], ["RERANKER_URL", "RERANKER_API_KEY"]]) {
    const target = new URL(env[urlKey] ?? "http://invalid");
    if (!["provider", "host.docker.internal", "127.0.0.1", "localhost"].includes(target.hostname) || target.protocol !== "http:" || target.port !== new URL(proxy).port || env[keyKey] !== token)
      throw Error("ALL_ACCEPTANCE_PROVIDERS_MUST_USE_THE_AUTHENTICATED_BUDGET_PROXY");
  }
  if (new URL(env.LLM_BASE_URL).hostname === "provider") {
    const project = info.Config.Labels["com.docker.compose.project"];
    const { stdout } = await exec("docker", ["inspect", `${project}-provider-1`], { maxBuffer: 1_000_000 });
    const gateway = JSON.parse(stdout)[0];
    if (gateway.Config.Labels["com.docker.compose.project"] !== project || gateway.Config.Labels["com.docker.compose.service"] !== "provider" ||
      JSON.stringify(gateway.Config.Cmd) !== JSON.stringify(["node", "scripts/ai-acceptance-provider.mjs"]) ||
      !gateway.Mounts.some((mount) => mount.Destination === "/app/acceptance-budget" && mount.Type === "bind") ||
      !gateway.Config.Env.includes(`AI_ACCEPTANCE_PROXY_TOKEN=${token}`))
      throw Error("PERSISTENT_SAME_PROJECT_BUDGET_GATEWAY_REQUIRED");
  }
} else {
  for (const key of ["LLM_BASE_URL", "EMBEDDING_BASE_URL", "RERANKER_URL"]) {
    const target = new URL(env[key] ?? "http://invalid");
    if (target.protocol !== "http:" || !["provider", "host.docker.internal", "localhost", "127.0.0.1"].includes(target.hostname))
      throw Error("SYNTHETIC_MATRIX_REQUIRES_LOCAL_FAKE_PROVIDERS");
  }
}
const report = { startedAt: new Date().toISOString(), mode, suite, providerKind, syntheticDataOnly: true, base, cases: [], documents: [],
  boundary: "Fixed synthetic cases, not real-user accuracy; matrix mode verifies contracts with fake providers." };
report.models = Object.fromEntries(["LLM_MODEL_ID", "EMBEDDING_MODEL", "EMBEDDING_DIMENSION", "RERANKER_MODEL", "RERANKER_ENABLED"].map((key) => [key, env[key]]));
report.sourceHashes = Object.fromEntries(await Promise.all([
  "../src/ai-answer.ts", "../src/ai-support.ts", "../src/ai-provider.ts", "../src/ai-budget.ts", "./ai-quality.mjs", "./ai-quality-cases.mjs", "./ai-quality-holdout.mjs",
].map(async (file) => [file, createHash("sha256").update(await readFile(new URL(file, import.meta.url))).digest("hex")])));
const reportPath = process.env.AI_ACCEPTANCE_REPORT ?? `.delivery/ai-quality-${Date.now()}.json`;
const selectedIds = process.env.AI_QUALITY_CASE_IDS?.split(",").filter(Boolean);
const cases = (suite === "holdout" ? holdoutCases : qualityCases).filter((c) => (!selectedIds || selectedIds.includes(c.id)) && (mode === "matrix" || c.live));
report.expectedCases = cases.map((c) => c.id);
const cookies = new Map();
const headers = (jar) => ({ Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "), "Content-Type": "application/json", "X-ShopMate-Request": "1" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (ok, code) => { if (!ok) throw Error(code); };
const localDeadline = Date.now() + 20 * 60_000;
async function budgetStatus() {
  if (!proxy) return null;
  const response = await fetch(`${proxy}/status`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
  assert(response.ok, "PROXY_STATUS_FAILED");
  const ledger = await response.json();
  assert(ledger.maxRequests <= 100 && ledger.maxDurationMs <= 1_200_000, "ACCEPTANCE_BUDGET_TOO_LARGE");
  return ledger;
}
async function boundary() {
  assert(Date.now() < localDeadline, "ACCEPTANCE_TIME_EXHAUSTED");
  const ledger = await budgetStatus();
  if (ledger) assert(ledger.requests.length < ledger.maxRequests && (ledger.deadline === null || Date.now() < ledger.deadline), "ACCEPTANCE_BUDGET_EXHAUSTED");
}
async function call(path, body, jar = cookies, allowError = false) {
  const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: headers(jar),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) });
  for (const c of response.headers.getSetCookie()) {
    const [pair] = c.split(";"), at = pair.indexOf("=");
    jar.set(pair.slice(0, at), pair.slice(at + 1));
  }
  const data = await response.json();
  if (!response.ok && !allowError) throw Error(`${path}:${response.status}:${data.code ?? "HTTP_FAILED"}`);
  return allowError ? { status: response.status, data } : data;
}
const action = async (method, args, jar = cookies, requestId = randomUUID(), allowError = false) => {
  const result = await call(`/api/actions/${method}`, { args, requestId }, jar, allowError);
  return allowError ? result : result.result;
};
const state = async (jar = cookies) => (await readHttpSnapshot((path) => call(path, undefined, jar))).db;
async function makeUser(jar = cookies) {
  await call("/api/auth/register", { username: `quality_${randomUUID().replaceAll("-", "").slice(0, 12)}`, name: "合成质量验收用户", password: "SyntheticPass123!" }, jar);
  await action("saveAddress", [{ name: "合成收件人", phone: "13800000000", province: "上海市", region: "上海市 徐汇区", detail: "隔离合成验收地址", isDefault: true }], jar);
}
async function order(pay = false, jar = cookies) {
  const db = await state(jar);
  const quote = await action("quoteCheckout", [{ source: { type: "buyNow", productId: "p01", skuId: "p01-s1", quantity: 1 }, addressId: db.addresses[0].id }], jar);
  const id = await action("createOrder", [{ quoteId: quote.id, requestId: randomUUID() }], jar);
  if (pay) await action("payOrder", [id], jar);
  return (await state(jar)).orders.find((o) => o.id === id);
}
function businessDigest(db) {
  return createHash("sha256").update(JSON.stringify({ carts: db.carts, orders: db.orders, afterSales: db.afterSales })).digest("hex");
}
async function telemetry(runIds) {
  const { stdout, stderr } = await exec("docker", ["logs", "--since", report.startedAt, container], { maxBuffer: 20 * 1024 * 1024 });
  const records = `${stdout}\n${stderr}`.split(/\r?\n/).flatMap((line) => {
    try { const item = JSON.parse(line); return runIds.includes(item.runId) ? [item] : []; } catch { return []; }
  });
  return {
    runIds,
    retrievedSourceIds: [...new Set(records.filter((r) => r.event === "support_knowledge_retrieved").flatMap((r) => r.sourceIds ?? []))],
    modelCalls: records.filter((r) => r.event === "support_model_call").map((r) => ({ runId: r.runId, call: r.call, durationMs: r.durationMs,
      usage: Object.keys(r.usage ?? {}).length ? r.usage : "unknown" })),
    tools: records.filter((r) => r.event === "support_tool_call").map((r) => ({ name: r.name, ok: r.ok })),
  };
}
async function ask(question, context, chatId) {
  await boundary();
  const id = chatId ?? await action("createConversation", context && Object.keys(context).length ? [context] : []);
  await action("sendMessage", [id, question]);
  const end = Math.min(localDeadline, Date.now() + 100_000);
  while (Date.now() < end) {
    const detail = await call(`/api/support/conversations/${id}`);
    if (["completed", "failed", "cancelled"].includes(detail.run?.status)) return { id, ...detail,
      answer: detail.conversation.messages.find((m) => m.id === `ai-${detail.run.id}`) ?? detail.conversation.messages.at(-1) };
    await sleep(300);
  }
  throw Error("QUALITY_RUN_TIMEOUT");
}
const published = new Map();
try {
  await boundary();
  await call("/api/auth/login", { role: "admin", username: process.env.E2E_ADMIN_USERNAME ?? "admin", password: process.env.E2E_ADMIN_PASSWORD });
  await makeUser();
  for (const doc of knowledgeDocuments.filter((d) => mode === "matrix" || d.publish !== false)) {
    await boundary();
    const existing = (await call("/api/support/documents")).documents.find((item) => item.name === doc.name);
    if (existing) {
      const current = (await call(`/api/support/documents/${existing.id}`)).document;
      assert(current.text === doc.text.trim() && (doc.publish === false ? !current.publishedVersion : current.publishedVersion === current.version), "EXISTING_QUALITY_DOCUMENT_CHANGED");
      if (doc.publish !== false) published.set(doc.key, current);
      report.documents.push({ key: doc.key, id: current.id, version: current.version, published: doc.publish !== false, reused: true });
      continue;
    }
    let uploaded = (await call("/api/support/documents", { name: doc.name, contentBase64: Buffer.from(doc.text).toString("base64"), requestId: randomUUID() })).document;
    const until = Math.min(localDeadline, Date.now() + 180_000);
    while (Date.now() < until) {
      uploaded = (await call(`/api/support/documents/${uploaded.id}`)).document;
      if (["draft", "failed"].includes(uploaded.status)) break;
      await sleep(300);
    }
    assert(uploaded.status === "draft" && uploaded.text === doc.text.trim(), "DOCUMENT_INDEX_OR_EXTRACTION_FAILED");
    if (doc.publish !== false) {
      const result = await call(`/api/support/documents/${uploaded.id}/actions`, { action: "publish", version: uploaded.version, requestId: randomUUID() });
      published.set(doc.key, result.document);
    }
    report.documents.push({ key: doc.key, id: uploaded.id, version: uploaded.version, published: doc.publish !== false });
  }
  assert(cases.length > 0 && (!selectedIds || selectedIds.every((id) => cases.some((c) => c.id === id))), "UNKNOWN_OR_NONLIVE_QUALITY_CASE");
  for (const item of cases) {
    await boundary();
    const started = Date.now(), beforeBudget = await budgetStatus();
    try {
      let ownOrder;
      if (item.setupOrder || item.expected.order || ["A02", "A03", "A04", "A07", "C03", "S01"].includes(item.id))
        ownOrder = await order(item.setupPaidOrder || ["F05", "F08", "A03"].includes(item.id));
      if (item.id === "F08") await action("requestAfterSale", [ownOrder.id, "测试破损", "合成验收包装破损", [{ orderItemId: ownOrder.items[0].id, quantity: 1 }]]);
      let foreignOrder;
      if (["S02", "S03"].includes(item.id)) {
        const foreign = new Map(); await makeUser(foreign);
        if (item.id === "S03") {
          const foreignChat = await action("createConversation", [], foreign);
          const denied = await call(`/api/support/conversations/${foreignChat}`, undefined, cookies, true);
          report.cases.push({ ...evaluateQualityCase(item, { status: denied.status }), elapsedMs: Date.now() - started, expected: item.expected });
          continue;
        }
        foreignOrder = await order(false, foreign);
      }
      const db = await state(), product = db.products.find((p) => p.id === "p01"), sku = product.skus.find((s) => s.id === "p01-s1");
      const values = { productId: product.id, skuId: sku.id, orderId: ownOrder?.id ?? "", itemId: ownOrder?.items[0].id ?? "", foreignOrderId: foreignOrder?.id ?? "" };
      const question = item.question.replace(/\{(\w+)\}/g, (_, key) => values[key]);
      const scope = { ...((item.expected.product && item.expected.dynamic !== "budget") || item.expected.proposal === "addCart" ? { productId: product.id } : {}), ...(ownOrder ? { orderId: ownOrder.id } : {}) };
      const before = businessDigest(db), runIds = [];
      let detail;
      if (item.expected.followup) {
        const first = await ask(`查询商品${product.id}的材质`, { productId: product.id });
        assert(first.run?.status === "completed", "FOLLOWUP_PRECONDITION_FAILED");
        runIds.push(first.run.id);
        detail = await ask(question, {}, first.id);
      } else detail = await ask(question, scope);
      runIds.push(detail.run.id);
      const after = await state();
      const observation = { answer: detail.answer, proposals: detail.proposals, productId: product.id, orderId: ownOrder?.id,
        runStatus: detail.run.status, beforeUnchanged: before === businessDigest(after), dynamicChecks: [] };
      const cartCount = (snapshot) => snapshot.carts.filter((c) => c.skuId === sku.id).reduce((sum, c) => sum + c.quantity, 0);
      if (["price", "amount", "order"].includes(item.expected.dynamic)) {
        const amount = item.expected.dynamic === "price" ? sku.price : ownOrder.total;
        observation.dynamicChecks.push({ ok: answerHasAmount(detail.answer.text, amount), detail: `exact amount ${amount} cents expressed as yuan` });
        if (item.expected.dynamic === "order") observation.dynamicChecks.push({ ok: /待付款|待支付|未付款|等待付款|尚未支付/.test(detail.answer.text) && ownOrder.status === "pending" && detail.orders.some((order) => order.id === ownOrder.id && order.status === "pending"), detail: "pending answer and owned live order status agree" });
      }
      if (item.expected.dynamic === "stock") {
        const current = detail.products.find((p) => p.id === product.id)?.skus.find((s) => s.id === sku.id)?.stock;
        observation.dynamicChecks.push({ ok: Number.isInteger(current) && new RegExp(`(?<!\\d)${current}(?!\\d)`).test(detail.answer.text), detail: "answer contains available stock from live projection" });
      }
      if (item.expected.dynamic === "material") observation.dynamicChecks.push({ ok: detail.answer.text.includes(product.material), detail: "material matches server product" });
      if (item.expected.dynamic === "budget") observation.dynamicChecks.push({ ok: budgetRecommendationCheck(detail.answer, detail.products), detail: "each recommended live product has an in-budget available SKU" });
      if (item.expected.dynamic === "comparison") observation.dynamicChecks.push({
        ok: ["p01", "p02"].every((id) => detail.answer.productIds?.includes(id) &&
          answerHasAmount(detail.answer.text, db.products.find((product) => product.id === id).skus[0].price)),
        detail: "both requested products and their current prices are present",
      });
      if (item.expected.proposal) {
        const proposal = detail.proposals.find((p) => p.kind === item.expected.proposal && p.status === "pending");
        if (proposal) {
          const effect = item.expected.effect;
          if (effect === "decline") {
            await action("cancelSupportProposal", [proposal.id]);
            observation.effectVerified = businessDigest(await state()) === before;
          } else if (["staleCart", "paidOrder", "handoff"].includes(effect)) {
            if (effect === "staleCart") await action("addCart", [product.id, sku.id, 1]);
            if (effect === "paidOrder") await action("payOrder", [ownOrder.id]);
            if (effect === "handoff") await action("transferConversation", [detail.id]);
            const changed = businessDigest(await state());
            const response = await action("confirmSupportProposal", [proposal.id], cookies, randomUUID(), true);
            observation.effectVerified = [400, 409].includes(response.status) && changed === businessDigest(await state());
          } else {
            const requestId = randomUUID();
            await action("confirmSupportProposal", [proposal.id], cookies, requestId);
            if (effect === "duplicate") {
              await action("confirmSupportProposal", [proposal.id], cookies, requestId);
              await action("confirmSupportProposal", [proposal.id]);
            }
            const confirmed = await state();
            observation.effectVerified = item.expected.proposal === "addCart" ? cartCount(confirmed) === cartCount(db) + 1 :
              item.expected.proposal === "cancelOrder" ? confirmed.orders.find((o) => o.id === ownOrder.id)?.status === "cancelled" :
                confirmed.afterSales.filter((a) => a.orderId === ownOrder.id && a.lines[0]?.quantity === 1).length === 1;
          }
        }
      }
      const traces = await telemetry(runIds);
      observation.retrievedSourceIds = traces.retrievedSourceIds;
      if (item.expected.source) {
        const source = published.get(item.expected.source);
        const current = (await call(`/api/support/documents/${source.id}`)).document;
        observation.allowedSourceIds = current.publishedVersion === source.publishedVersion ? traces.retrievedSourceIds.filter((id) => id.startsWith(`${source.id}:v${source.publishedVersion}:`)) : [];
      }
      const result = evaluateQualityCase(item, observation), afterBudget = await budgetStatus();
      report.cases.push({ ...result, question, expected: item.expected, elapsedMs: Date.now() - started, runId: detail.run.id, runStatus: detail.run.status, runError: detail.run.error,
        degraded: detail.run.degraded, answer: detail.answer, trace: traces,
        providerRequests: afterBudget ? afterBudget.requests.slice(beforeBudget.requests.length) : null });
      console.log(JSON.stringify({ case: item.id, ok: result.ok, outcome: result.outcome }));
    } catch (error) {
      report.cases.push({ id: item.id, category: item.category, name: item.name, question: item.question, expected: item.expected, ok: false, error: error.message, checks: [], elapsedMs: Date.now() - started });
      console.log(JSON.stringify({ case: item.id, ok: false, error: error.message }));
    }
  }
} catch (error) { report.fatal = error.message; }
finally {
  report.finishedAt = new Date().toISOString();
  report.notRun = report.expectedCases.filter((id) => !report.cases.some((c) => c.id === id));
  report.summary = summarizeQuality(report.cases);
  report.budget = await budgetStatus().catch(() => null);
  report.ok = !report.fatal && report.cases.length === report.expectedCases?.length && report.cases.every((c) => c.ok);
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  await writeFile(reportPath.replace(/\.json$/, "") + ".human-review.json", JSON.stringify({
    status: "pending_human_review", sourceReport: reportPath, providerKind, suite,
    rubric: { factuality: "0=错误/无依据，1=部分正确，2=事实与引用均支持", relevance: "0=未回答，1=部分回答，2=直接解决问题", actionability: "0=错误操作/无效追问，1=部分有用，2=有效建议或只追问缺失字段" },
    cases: report.cases.map((item) => ({ id: item.id, question: item.question, answer: item.answer?.text,
      citations: item.answer?.citations, automatedResult: item.ok, scores: { factuality: null, relevance: null, actionability: null }, reviewer: null, notes: "" })),
  }, null, 2));
  console.log(JSON.stringify({ report: reportPath, ok: report.ok, summary: report.summary, fatal: report.fatal }));
  if (!report.ok) process.exitCode = 1;
}
