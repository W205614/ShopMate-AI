import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Scripts run under Node directly; no application build or credentials are needed.
// @ts-expect-error Native mjs acceptance utilities are deliberately outside the TypeScript application.
import { createAcceptanceBudget, createAcceptanceProxy, providerUsage } from "../scripts/ai-acceptance-provider.mjs";
// @ts-expect-error Native mjs acceptance contract.
import { qualityCases, evaluateQualityCase, summarizeQuality, budgetRecommendationCheck, answerHasAmount } from "../scripts/ai-quality-cases.mjs";
// @ts-expect-error Protocol double used only by isolated acceptance.
import { syntheticChat } from "../scripts/ai-quality-provider.mjs";
// @ts-expect-error Separate native-mjs evaluation set.
import { holdoutCases } from "../scripts/ai-quality-holdout.mjs";

describe("quality acceptance evidence guards", () => {
  it("keeps independent task questions and reports refusal and resolution denominators honestly", () => {
    expect(holdoutCases).toHaveLength(12);
    expect(holdoutCases.every((item: any) => !qualityCases.some((old: any) => old.question === item.question))).toBe(true);
    const item = holdoutCases.find((item: any) => item.id === "H03");
    const refused = evaluateQualityCase(item, { runStatus: "completed", answer: { replyKind: "handoff", text: "无法确认" } });
    expect(refused.ok).toBe(false);
    expect(refused.falseRefusal).toBe(true);
    expect(refused.outcome).toBe("safe_refusal");
    expect(evaluateQualityCase(holdoutCases.find((item: any) => item.id === "H06"), {
      runStatus: "completed", answer: { replyKind: "clarify", text: "请补充规格和数量" }, proposals: [],
    }).outcome).toBe("clarification");
    expect(summarizeQuality([{ ...refused, expected: item.expected, runStatus: "completed" },
      { ok: true, expected: { answerable: false }, outcome: "safe_refusal", checks: [] }]))
      .toMatchObject({ answerable: 1, resolvedAnswerable: 0, falseRefusals: 1, resolutionRate: 0, falseRefusalRate: 1 });
    expect(summarizeQuality([])).toMatchObject({ resolutionRate: null, falseRefusalRate: null });
  });
  it("locks the forty-case category contract and twelve live representatives", () => {
    expect(qualityCases).toHaveLength(40);
    expect(new Set(qualityCases.map((c: any) => c.id)).size).toBe(40);
    expect(Object.fromEntries(["knowledge", "facts", "clarification", "safety", "actions"].map((category) => [category, qualityCases.filter((c: any) => c.category === category).length])))
      .toEqual({ knowledge: 12, facts: 8, clarification: 6, safety: 6, actions: 8 });
    expect(qualityCases.filter((c: any) => c.live)).toHaveLength(12);
  });
  it("rejects numerically correct answers whose reference does not support the fact", () => {
    const sample = qualityCases.find((c: any) => c.id === "K01");
    const result = evaluateQualityCase(sample, { runStatus: "completed", retrievedSourceIds: ["live-v1"], allowedSourceIds: ["live-v1"],
      answer: { text: "30摄氏度，不可漂白", citations: [{ id: "live-v1", text: "另一份无关政策" }] } });
    expect(result.ok).toBe(false);
    expect(result.checks.some((c: any) => c.kind === "citationSupport" && !c.ok)).toBe(true);
  });
  it("rejects stale references, missing retrieval evidence and missing dynamic assertions", () => {
    const sample = qualityCases.find((c: any) => c.id === "K03");
    const result = evaluateQualityCase(sample, { runStatus: "completed", retrievedSourceIds: ["old-v1"], allowedSourceIds: ["live-v2"],
      answer: { text: "17天", citations: [{ id: "old-v1", text: "保修17天" }] } });
    expect(result.ok).toBe(false);
    expect(evaluateQualityCase(qualityCases.find((c: any) => c.id === "F01"), { runStatus: "completed", answer: { productIds: ["p01"] }, productId: "p01" }).ok).toBe(false);
  });
  it("never counts fallback as a successful normal answer, and requires the business boundary for safety", () => {
    const observation = { runStatus: "failed", answer: { source: "rule", text: "请稍后重试" }, beforeUnchanged: true };
    expect(evaluateQualityCase(qualityCases.find((c: any) => c.id === "F01"), observation).ok).toBe(false);
    const safety = evaluateQualityCase(qualityCases.find((c: any) => c.id === "S01"), observation);
    expect(safety.ok).toBe(true);
    expect(summarizeQuality([safety])).toMatchObject({ normalAnswers: 0, safeRefusals: 0, degraded: 1 });
    expect(evaluateQualityCase(qualityCases.find((c: any) => c.id === "S01"), { ...observation, beforeUnchanged: false }).ok).toBe(false);
  });
  it("checks both unconfirmed state and verified action effects", () => {
    const sample = qualityCases.find((c: any) => c.id === "A01");
    const observation = { runStatus: "completed", answer: { text: "请确认" }, proposals: [{ kind: "addCart", status: "pending" }], beforeUnchanged: true, effectVerified: false };
    expect(evaluateQualityCase(sample, observation).ok).toBe(false);
    expect(evaluateQualityCase(sample, { ...observation, effectVerified: true }).ok).toBe(true);
  });
  it("reports retrieval degradation independently from provider and format failures", () => {
    const summary = summarizeQuality([
      { ok: true, outcome: "normal_answer", runStatus: "completed", degraded: ["embedding_unavailable_keyword_only"], checks: [] },
      { ok: false, outcome: "safe_degradation", runStatus: "failed", runError: "AI_PROVIDER_FAILED", checks: [] },
      { ok: false, outcome: "safe_degradation", runStatus: "failed", runError: "AI_INVALID_RESPONSE", checks: [] },
    ]);
    expect(summary).toMatchObject({ retrievalDegraded: 1, providerFailure: 1, formatFailure: 1, degraded: 2 });
  });
  it("renders actual tool values in the protocol double without reading the expected-case matrix", () => {
    const product = { id: "custom", material: "新材质", name: "临时品", skus: [{ id: "sku-x", price: 12345, availableStock: 7 }] };
    const response = syntheticChat([{ role: "user", content: "查询商品custom规格sku-x的价格" },
      { role: "assistant", tool_calls: [{ function: { name: "product_details" } }] }, { role: "tool", content: JSON.stringify(product) }]);
    const answer = JSON.parse(response.content);
    expect(answer.answer).toContain("123.45元"); expect(answer.answer).toContain("7件"); expect(answer.productIds).toEqual(["custom"]);
  });
  it("checks only recommended products while rejecting an unavailable or over-budget recommendation", () => {
    const products = [{ id: "context-only", skus: [{ price: 20000, stock: 8 }] }, { id: "recommended", skus: [{ price: 6900, stock: 1 }] }];
    expect(budgetRecommendationCheck({ productIds: ["recommended"] }, products)).toBe(true);
    expect(budgetRecommendationCheck({ productIds: ["context-only"] }, products)).toBe(false);
    expect(budgetRecommendationCheck({ productIds: ["recommended"] }, [{ id: "recommended", skus: [{ price: 6900, stock: 0 }] }])).toBe(false);
    expect(budgetRecommendationCheck({ productIds: ["missing"] }, products)).toBe(false);
  });
  it("compares integer, one-decimal and two-decimal yuan prices exactly in cents", () => {
    for (const value of ["399元", "399.0 元", "399.00 元", "¥399", "￥ 399.00", "价格为399.00元。"])
      expect(answerHasAmount(value, 39900), value).toBe(true);
    expect(answerHasAmount("29.9元", 2990)).toBe(true);
    expect(answerHasAmount("￥0.01", 1)).toBe(true);
    for (const value of ["1399元", "3990元", "399.01元", "399.001元", "399.000元", "订单39900", "-399元", "3,399.00元", "399分"])
      expect(answerHasAmount(value, 39900), value).toBe(false);
    expect(answerHasAmount("399.00元", 39901)).toBe(false);
  });
});

describe("durable real-provider acceptance budget", () => {
  const ledger = () => join(mkdtempSync(join(tmpdir(), "shopmate-quality-budget-")), "budget.json");
  it("reserves failed/incomplete requests durably and preserves cap and deadline across restart", () => {
    const file = ledger(), first = createAcceptanceBudget(file, { maxRequests: 2, maxDurationMs: 1000 });
    first.claim("chat", 1000); first.finish(first.snapshot().requests[0].id, { status: "failed" });
    const restarted = createAcceptanceBudget(file, { maxRequests: 2, maxDurationMs: 1000 });
    restarted.claim("embedding", 1500);
    expect(restarted.snapshot()).toMatchObject({ startedAt: 1000, deadline: 2000 });
    expect(() => restarted.claim("rerank", 1501)).toThrow("BUDGET_EXHAUSTED");
    expect(() => createAcceptanceBudget(file, { maxRequests: 3, maxDurationMs: 1000 })).toThrow("INVALID_ACCEPTANCE_LEDGER");
    expect(() => createAcceptanceBudget(ledger(), { maxRequests: 3, maxDurationMs: 1000 }).claim("chat", 1000)).not.toThrow();
  });
  it("fails closed at deadline and reports absent provider usage as unknown", () => {
    const budget = createAcceptanceBudget(ledger(), { maxDurationMs: 5 }); budget.claim("embedding", 1000);
    expect(() => budget.claim("chat", 1005)).toThrow("BUDGET_EXHAUSTED");
    expect(providerUsage({})).toBe("unknown"); expect(providerUsage({ usage: { total_tokens: 0, prompt_tokens: -1, extra: "secret" } })).toEqual({ total_tokens: 0 });
  });
  it("authenticates before spending and counts all three service kinds, including failures", async () => {
    const budget = createAcceptanceBudget(ledger(), { maxRequests: 3 });
    const token = "synthetic-proxy-token-long-enough";
    const fetcher = async (_url: URL, init: any) => {
      expect(init.headers.Authorization).toBe("Bearer upstream-private");
      return new Response(JSON.stringify({ usage: { total_tokens: 5 } }), { status: 200 });
    };
    const upstream = { base: "https://provider.invalid", key: "upstream-private" };
    const server = createAcceptanceProxy({ token, budget, upstreams: { chat: upstream, embedding: upstream, rerank: upstream }, fetcher });
    server.listen(0, "127.0.0.1"); await new Promise<void>((done) => server.once("listening", done));
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    try {
      expect((await fetch(base + "/chat/completions", { method: "POST", body: "{}" })).status).toBe(401);
      expect(budget.snapshot().requests).toHaveLength(0);
      for (const path of ["/chat/completions", "/embeddings", "/rerank"]) expect((await fetch(base + path, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: "{}" })).status).toBe(200);
      expect(budget.snapshot().requests.map((r: any) => r.kind)).toEqual(["chat", "embedding", "rerank"]);
      expect((await fetch(base + "/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: "{}" })).status).toBe(429);
      expect(JSON.stringify(budget.snapshot())).not.toContain("upstream-private");
    } finally { server.closeAllConnections(); await new Promise<void>((done) => server.close(done)); }
  });
});
