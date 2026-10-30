import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  budgetDay,
  reserveConsultation,
  reserveProviderRequest,
  resourceLimits,
  withProviderBudget,
} from "../src/ai-budget";
import { chat, embed, rerank, vision } from "../src/ai-provider";
import { transaction } from "../src/database";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("durable AI service quotas", () => {
  it("fails closed when a runtime provider call omits its database budget", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LLM_API_KEY", "synthetic-key");
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(chat([])).rejects.toMatchObject({
      code: "AI_PROVIDER_BUDGET_CONTEXT_REQUIRED",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("uses Beijing calendar days", () => {
    expect(budgetDay(Date.parse("2026-10-28T15:59:59Z"))).toBe("2026-10-28");
    expect(budgetDay(Date.parse("2026-10-28T16:00:00Z"))).toBe("2026-10-29");
  });

  it.each([
    ["AI_DAILY_PROVIDER_CALLS", "0"],
    ["AI_USER_DAILY_CONSULTATIONS", "NaN"],
    ["SUPPORT_MAX_USER_TURNS", "1000000000"],
  ])(
    "rejects invalid %s rather than increasing the configured quota",
    (name, value) => {
      vi.stubEnv(name, value);
      expect(() => resourceLimits()).toThrow(name);
    },
  );

  it("keeps a shared cap across connections and close/reopen without resetting usage", () => {
    vi.stubEnv("AI_DAILY_PROVIDER_CALLS", "2");
    // Isolated OS-temp database, never a project data/backup path.
    const path = join(
      mkdtempSync(join(tmpdir(), "shopmate-budget-test-")),
      "budget.sqlite",
    );
    let first = new DatabaseSync(path);
    const second = new DatabaseSync(path);
    try {
      reserveProviderRequest(first);
      reserveProviderRequest(second);
      first.close();
      first = new DatabaseSync(path);
      expect(() => reserveProviderRequest(first)).toThrowError(
        expect.objectContaining({
          code: "AI_PROVIDER_BUDGET_EXHAUSTED",
          status: 429,
        }),
      );
      expect(
        second
          .prepare("SELECT used FROM ai_daily_usage WHERE kind='provider'")
          .get()?.used,
      ).toBe(2);
    } finally {
      first.close();
      second.close();
    }
  });

  it("isolates per-user consultation quotas, rolls back rejected business mutations and resets only on a new day", () => {
    vi.stubEnv("AI_USER_DAILY_CONSULTATIONS", "1");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-28T15:59:59Z"));
    const sql = new DatabaseSync(":memory:");
    try {
      expect(() =>
        transaction(sql, () => {
          reserveConsultation(sql, "u1");
          throw new Error("business rejected");
        }),
      ).toThrow("business rejected");
      reserveConsultation(sql, "u1");
      reserveConsultation(sql, "u2");
      expect(() => reserveConsultation(sql, "u1")).toThrowError(
        expect.objectContaining({ code: "AI_USER_BUDGET_EXHAUSTED" }),
      );
      vi.setSystemTime(new Date("2026-10-28T16:00:00Z"));
      reserveConsultation(sql, "u1");
      expect(
        sql.prepare("SELECT sum(used) AS used FROM ai_daily_usage").get()?.used,
      ).toBe(3);
    } finally {
      sql.close();
    }
  });

  it("counts failed chat, embedding, rerank and vision calls before I/O without holding a transaction", async () => {
    vi.stubEnv("AI_DAILY_PROVIDER_CALLS", "4");
    vi.stubEnv("LLM_API_KEY", "synthetic-key");
    vi.stubEnv("LLM_BASE_URL", "https://provider.invalid/v1");
    vi.stubEnv("EMBEDDING_API_KEY", "synthetic-key");
    vi.stubEnv("EMBEDDING_BASE_URL", "https://provider.invalid/v1");
    vi.stubEnv("EMBEDDING_DIMENSION", "3");
    vi.stubEnv("EMBEDDING_DIMENSIONS", "");
    vi.stubEnv("RERANKER_ENABLED", "true");
    vi.stubEnv("RERANKER_API_KEY", "synthetic-key");
    vi.stubEnv("RERANKER_URL", "https://provider.invalid/v1/rerank");
    const sql = new DatabaseSync(":memory:");
    const fetcher = vi.fn(async (url: URL) => {
      expect(sql.isTransaction).toBe(false);
      if (fetcher.mock.calls.length === 1)
        return new Response("", { status: 503 });
      if (url.pathname.endsWith("embeddings"))
        return Response.json({ data: [{ index: 0, embedding: [1, 0, 0] }] });
      if (url.pathname.endsWith("rerank"))
        return Response.json({ results: [{ index: 0, relevance_score: 1 }] });
      return Response.json({
        choices: [{ message: { role: "assistant", content: "合成识别正文" } }],
      });
    });
    vi.stubGlobal("fetch", fetcher);
    try {
      await expect(
        withProviderBudget(sql, () => chat([])),
      ).rejects.toMatchObject({ code: "PROVIDER_HTTP_503" });
      await withProviderBudget(sql, () => embed(["合成"]));
      await withProviderBudget(sql, () => rerank("合成", ["正文"]));
      await withProviderBudget(sql, () =>
        vision(Buffer.from("synthetic"), "image/png"),
      );
      await expect(
        withProviderBudget(sql, () => chat([])),
      ).rejects.toMatchObject({
        code: "AI_PROVIDER_BUDGET_EXHAUSTED",
        status: 429,
      });
      expect(fetcher).toHaveBeenCalledTimes(4);
      expect(
        sql
          .prepare("SELECT used FROM ai_daily_usage WHERE kind='provider'")
          .get()?.used,
      ).toBe(4);
    } finally {
      sql.close();
    }
  });
});
