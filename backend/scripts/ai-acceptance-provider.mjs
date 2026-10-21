/** Authenticated, bounded provider gateway for isolated synthetic acceptance only. */
import { createServer } from "node:http";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function createAcceptanceBudget(file, options = {}) {
  const maxRequests = Math.min(100, options.maxRequests ?? 100);
  const maxDurationMs = Math.min(20 * 60_000, options.maxDurationMs ?? 20 * 60_000);
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || !Number.isSafeInteger(maxDurationMs) || maxDurationMs < 1)
    throw Error("INVALID_ACCEPTANCE_BUDGET");
  let ledger = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {
    version: 1, startedAt: null, deadline: null, maxRequests, maxDurationMs, requests: [],
  };
  if (ledger.version !== 1 || !Array.isArray(ledger.requests) || ledger.maxRequests !== maxRequests || ledger.maxDurationMs !== maxDurationMs ||
      (ledger.startedAt !== null && (!Number.isFinite(ledger.startedAt) || ledger.deadline !== ledger.startedAt + maxDurationMs)))
    throw Error("INVALID_ACCEPTANCE_LEDGER");
  const save = () => {
    mkdirSync(dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.partial`;
    writeFileSync(temporary, JSON.stringify(ledger, null, 2), { mode: 0o600 });
    renameSync(temporary, file);
  };
  return {
    claim(kind, now = Date.now()) {
      if (ledger.requests.length >= maxRequests || (ledger.deadline !== null && now >= ledger.deadline))
        throw Error("ACCEPTANCE_BUDGET_EXHAUSTED");
      if (ledger.startedAt === null) {
        ledger.startedAt = now;
        ledger.deadline = now + maxDurationMs;
      }
      const entry = { id: randomUUID(), kind, startedAt: now, status: "incomplete", usage: "unknown" };
      ledger.requests.push(entry);
      // Reserve durably BEFORE any network call, including requests that later fail or crash.
      save();
      return entry.id;
    },
    finish(id, values) {
      const entry = ledger.requests.find((v) => v.id === id);
      if (!entry) throw Error("UNKNOWN_ACCEPTANCE_REQUEST");
      Object.assign(entry, values);
      save();
    },
    snapshot() { return structuredClone(ledger); },
  };
}

function endpoint(base, path) {
  if (!base) throw Error("ACCEPTANCE_UPSTREAM_NOT_CONFIGURED");
  const url = new URL(base.replace(/\/$/, "").endsWith(`/${path}`) ? base : `${base.replace(/\/$/, "")}/${path}`);
  if (url.protocol !== "https:" || url.username || url.password) throw Error("ACCEPTANCE_UPSTREAM_REQUIRES_HTTPS");
  return url;
}

export function providerUsage(data) {
  const entries = Object.entries(data?.usage ?? {}).filter(([key, value]) =>
    ["prompt_tokens", "completion_tokens", "total_tokens"].includes(key) && Number.isSafeInteger(value) && value >= 0);
  return entries.length ? Object.fromEntries(entries) : "unknown";
}

export function createAcceptanceProxy({ token, budget, upstreams, fetcher = fetch }) {
  if (typeof token !== "string" || token.length < 24) throw Error("ACCEPTANCE_PROXY_TOKEN_REQUIRED");
  const expected = Buffer.from(`Bearer ${token}`);
  return createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    const supplied = Buffer.from(req.headers.authorization ?? "");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      res.writeHead(401).end('{"code":"ACCEPTANCE_AUTH_REQUIRED"}');
      return;
    }
    if (req.method === "GET" && req.url === "/status") {
      res.end(JSON.stringify(budget.snapshot()));
      return;
    }
    const kind = ({ "/chat/completions": "chat", "/embeddings": "embedding", "/rerank": "rerank" })[req.url];
    if (req.method !== "POST" || !kind) {
      res.writeHead(404).end('{"code":"NOT_FOUND"}');
      return;
    }
    let id;
    const started = Date.now();
    try {
      const target = upstreams[kind];
      if (!target?.key) throw Error("ACCEPTANCE_UPSTREAM_NOT_CONFIGURED");
      const url = endpoint(target.base, kind === "chat" ? "chat/completions" : kind === "embedding" ? "embeddings" : "rerank");
      const chunks = [];
      let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 8 * 1024 * 1024) throw Error("ACCEPTANCE_BODY_LIMIT");
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      JSON.parse(body.toString("utf8"));
      id = budget.claim(kind);
      const remaining = Math.max(1, budget.snapshot().deadline - Date.now());
      const upstream = await fetcher(url, {
        method: "POST", redirect: "error",
        headers: { Authorization: `Bearer ${target.key}`, "Content-Type": "application/json" },
        body, signal: AbortSignal.timeout(Math.min(90_000, remaining)),
      });
      const reader = upstream.body?.getReader();
      if (!reader) throw Error("ACCEPTANCE_EMPTY_RESPONSE");
      const parts = [];
      let size = 0;
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.length;
        if (size > 8 * 1024 * 1024) { await reader.cancel(); throw Error("ACCEPTANCE_RESPONSE_LIMIT"); }
        parts.push(next.value);
      }
      const responseBody = Buffer.concat(parts);
      let usage = "unknown";
      try { usage = providerUsage(JSON.parse(responseBody.toString("utf8"))); } catch { /* Preserve invalid JSON for the application's fault handling. */ }
      budget.finish(id, { status: upstream.status, durationMs: Date.now() - started, usage });
      // Provider error bodies can echo secrets; only successful payloads enter the isolated API.
      res.writeHead(upstream.status).end(upstream.ok ? responseBody : JSON.stringify({ code: `PROVIDER_HTTP_${upstream.status}` }));
    } catch (error) {
      const code = error?.message === "ACCEPTANCE_BUDGET_EXHAUSTED" ? "ACCEPTANCE_BUDGET_EXHAUSTED" : "ACCEPTANCE_PROXY_FAILED";
      if (id) budget.finish(id, { status: "failed", durationMs: Date.now() - started, usage: "unknown" });
      res.writeHead(code === "ACCEPTANCE_BUDGET_EXHAUSTED" ? 429 : 502).end(JSON.stringify({ code }));
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.env.AI_ACCEPTANCE_ALLOWED !== "1") throw Error("ISOLATED_ACCEPTANCE_AUTHORIZATION_REQUIRED");
  const file = resolve(process.env.AI_ACCEPTANCE_BUDGET_FILE ?? ".delivery/ai-provider-budget.json");
  const budget = createAcceptanceBudget(file);
  const server = createAcceptanceProxy({
    token: process.env.AI_ACCEPTANCE_PROXY_TOKEN,
    budget,
    upstreams: {
      chat: { base: process.env.LLM_BASE_URL, key: process.env.LLM_API_KEY },
      embedding: { base: process.env.EMBEDDING_BASE_URL || process.env.EMBEDDING_API_BASE, key: process.env.EMBEDDING_API_KEY },
      rerank: { base: process.env.RERANKER_BASE_URL || process.env.RERANKER_URL, key: process.env.RERANKER_API_KEY },
    },
  });
  const port = Number(process.env.AI_ACCEPTANCE_PROXY_PORT ?? 18102);
  server.listen(port, process.env.AI_ACCEPTANCE_PROXY_HOST ?? "127.0.0.1", () =>
    console.log(JSON.stringify({ event: "acceptance_proxy_started", port, ledger: file, maxRequests: 100, maxDurationMs: 1_200_000 })));
}
