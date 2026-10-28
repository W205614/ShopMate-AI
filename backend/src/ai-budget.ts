import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { transaction } from "./database";
import { HttpError } from "./errors";

type BudgetGuard = () => void | Promise<void>;
const providerBudget = new AsyncLocalStorage<BudgetGuard>();

function positiveLimit(name: string, fallback: number, maximum: number) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isSafeInteger(value) && value >= 1 && value <= maximum
    ? value
    : fallback;
}

export function resourceLimits() {
  return {
    userDailyConsultations: positiveLimit(
      "AI_USER_DAILY_CONSULTATIONS",
      20,
      10000,
    ),
    dailyProviderCalls: positiveLimit("AI_DAILY_PROVIDER_CALLS", 100, 100000),
    dailyConversations: positiveLimit("SUPPORT_DAILY_CONVERSATIONS", 20, 1000),
    userTurns: positiveLimit("SUPPORT_MAX_USER_TURNS", 100, 1000),
  };
}

/** Beijing calendar days are independent of the host/container timezone. */
export function budgetDay(at = Date.now()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(at)
      .map(({ type, value }) => [type, value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function reserve(
  sql: DatabaseSync,
  kind: string,
  subject: string,
  limit: number,
  code: string,
  message: string,
) {
  const apply = () => {
    sql.exec(`CREATE TABLE IF NOT EXISTS ai_daily_usage(
      day TEXT NOT NULL,kind TEXT NOT NULL,subject TEXT NOT NULL,
      used INTEGER NOT NULL CHECK(used>=0),PRIMARY KEY(day,kind,subject));`);
    const result = sql
      .prepare(
        `INSERT INTO ai_daily_usage(day,kind,subject,used)
      VALUES(?,?,?,1) ON CONFLICT(day,kind,subject) DO UPDATE SET used=used+1
      WHERE used<? RETURNING used`,
      )
      .get(budgetDay(), kind, subject, limit);
    if (!result) throw new HttpError(429, message, code);
  };
  // Business mutations already own an immediate transaction. External calls
  // acquire and release their own short reservation before awaiting the network.
  if (sql.isTransaction) apply();
  else transaction(sql, apply);
}

export function reserveConsultation(sql: DatabaseSync, userId: string) {
  reserve(
    sql,
    "consultation",
    userId,
    resourceLimits().userDailyConsultations,
    "AI_USER_BUDGET_EXHAUSTED",
    "今日 AI 咨询次数已用完，可以转人工或明日再试",
  );
}

export function reserveNewConversation(sql: DatabaseSync, userId: string) {
  reserve(
    sql,
    "conversation",
    userId,
    resourceLimits().dailyConversations,
    "SUPPORT_CONVERSATION_LIMIT",
    "今日新建咨询次数已达上限，请继续已有会话或明日再试",
  );
}

export function reserveProviderRequest(sql: DatabaseSync) {
  reserve(
    sql,
    "provider",
    "global",
    resourceLimits().dailyProviderCalls,
    "AI_PROVIDER_BUDGET_EXHAUSTED",
    "今日 AI 服务额度已用完，可以转人工或明日再试",
  );
}

export function withProviderBudget<T>(sql: DatabaseSync, work: () => T): T {
  return providerBudget.run(() => reserveProviderRequest(sql), work);
}

type Pending = {
  resolve: () => void;
  reject: (error: Error) => void;
};
const pending = new Map<string, Pending>();

class WorkerBudgetError extends Error {
  readonly code = "AI_PROVIDER_BUDGET_EXHAUSTED";
}

if (process.env.AI_DOCUMENT_WORKER === "1") {
  process.on("message", (raw: unknown) => {
    if (!raw || typeof raw !== "object") return;
    const reply = raw as { budgetResponse?: string; approved?: boolean };
    if (typeof reply.budgetResponse !== "string") return;
    const request = pending.get(reply.budgetResponse);
    if (!request) return;
    if (reply.approved === true) request.resolve();
    else request.reject(new WorkerBudgetError("AI_PROVIDER_BUDGET_EXHAUSTED"));
  });
  process.on("disconnect", () => {
    for (const request of pending.values())
      request.reject(new WorkerBudgetError("AI_PROVIDER_BUDGET_EXHAUSTED"));
  });
}

function requestWorkerBudget(signal: AbortSignal) {
  if (!process.send || !process.connected)
    throw new WorkerBudgetError("AI_PROVIDER_BUDGET_EXHAUSTED");
  return new Promise<void>((resolve, reject) => {
    const id = randomUUID();
    const finish = (error?: Error) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      pending.delete(id);
      if (error) reject(error);
      else resolve();
    };
    const cancel = () => finish(new Error("PROVIDER_CANCELLED"));
    const timer = setTimeout(
      () => finish(new WorkerBudgetError("AI_PROVIDER_BUDGET_EXHAUSTED")),
      5000,
    );
    pending.set(id, {
      resolve: () => finish(),
      reject: (error) => finish(error),
    });
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) return cancel();
    process.send!({ budgetRequest: id }, (error) => {
      if (error) finish(new WorkerBudgetError("AI_PROVIDER_BUDGET_EXHAUSTED"));
    });
  });
}

/** Production entrypoints install the DB guard; isolated protocol tests need no DB. */
export async function acquireProviderBudget(signal: AbortSignal) {
  signal.throwIfAborted();
  const guard = providerBudget.getStore();
  if (guard) await guard();
  else if (process.env.AI_DOCUMENT_WORKER === "1")
    await requestWorkerBudget(signal);
  else if (process.env.NODE_ENV !== "test")
    throw new HttpError(
      503,
      "AI 服务未完成额度配置",
      "AI_PROVIDER_BUDGET_CONTEXT_REQUIRED",
    );
  signal.throwIfAborted();
}
