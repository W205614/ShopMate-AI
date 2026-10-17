import type { Database, Role, Session } from "../domain/types";
const emptyDatabase = (): Database => ({
  version: 2,
  coupons: [],
  couponClaims: [],
  reviews: [],
  checkoutQuotes: [],
  orderRequests: [],
  revision: 0,
  users: [],
  products: [],
  categories: [],
  carts: [],
  addresses: [],
  favorites: {},
  orders: [],
  afterSales: [],
  inventory: [],
  ledger: [],
  conversations: [],
  faqs: [],
  settings: { name: "ShopMate-AI", slogan: "好物与答案，一起找到", notice: "" },
});
let database = emptyDatabase();
let sessions: Record<Role, Session | null> = { user: null, admin: null };
let issue = "";
let scope: Role = "user";
let sequence = 0;
let hasSnapshot = false;
let confirmedNotice = "";
const confirmedLogouts = new Set<Role>();
export const hasConfirmedLogout = (role: Role) => confirmedLogouts.has(role);
export interface SyncStatus {
  phase: "ready" | "stale" | "unavailable";
  role: Role;
}
let syncStatus: SyncStatus = { phase: "unavailable", role: "user" };
export const getSyncStatus = () => ({ ...syncStatus });
export const canMutate = () => syncStatus.phase === "ready";
export function requireFreshState() {
  if (!canMutate()) throw new Error("最新数据尚未同步，请重新连接后操作");
}
export class RequestError extends Error {
  outcome: "rejected" | "unknown" | "read-failed";
  status?: number;
  constructor(
    message: string,
    outcome: "rejected" | "unknown" | "read-failed",
    status?: number,
  ) {
    super(message);
    this.outcome = outcome;
    this.status = status;
  }
}
function connectionIssue(message: string) {
  syncStatus = { role: scope, phase: hasSnapshot ? "stale" : "unavailable" };
  issue = confirmedNotice + message;
  notify();
}
export function unknownMutation(status?: number) {
  confirmedNotice = "";
  connectionIssue("提交结果需要核对，请重新连接并检查最新记录。");
  return new RequestError(
    "请求结果暂无法确认，请先重新连接核对记录，避免重复提交",
    "unknown",
    status,
  );
}
export function invalidateIdentitySnapshot(role: Role) {
  sequence++;
  confirmedLogouts.delete(role);
  if (scope === role) {
    database = emptyDatabase();
    hasSnapshot = false;
    syncStatus = { role, phase: "unavailable" };
    notify();
  }
}
function validSession(value: Session | null, role: Role) {
  return (
    value === null ||
    (value &&
      value.role === role &&
      typeof value.id === "string" &&
      value.id.length > 0 &&
      typeof value.name === "string")
  );
}
export function confirmSession(
  role: Role,
  session: Session | null,
  identityBoundary = true,
) {
  if (!validSession(session, role)) throw unknownMutation();
  sequence++;
  const changedIdentity = sessions[role]?.id !== session?.id;
  sessions = { ...sessions, [role]: session };
  if (session) confirmedLogouts.delete(role);
  else confirmedLogouts.add(role);
  if (scope === role && (identityBoundary || changedIdentity)) {
    database = emptyDatabase();
    hasSnapshot = false;
    syncStatus = { role: scope, phase: "unavailable" };
  } else if (role === "user" && session) {
    database.users = database.users.map((user) =>
      user.id === session.id ? { ...user, name: session.name } : user,
    );
  }
  notify();
}
export async function synchronizeConfirmedMutation() {
  syncStatus = { role: scope, phase: hasSnapshot ? "stale" : "unavailable" };
  notify();
  try {
    await refreshState();
  } catch {
    if (syncStatus.phase !== "ready") {
      confirmedNotice = "操作已完成，最新数据未同步。";
      connectionIssue("请重新连接核对最新记录，勿重复提交。");
    }
  }
}
const listeners = new Set<(db: Database) => void>();
export const getDatabase = () => structuredClone(database);
export const getSession = (role: Role) => sessions[role];
export const getStorageIssue = () => issue;
export function subscribeDatabase(listener: (db: Database) => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function notify() {
  for (const listener of listeners) listener(getDatabase());
}
export async function request<T>(url: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      credentials: "same-origin",
      signal: AbortSignal.timeout(10_000),
      headers:
        body === undefined
          ? {}
          : { "Content-Type": "application/json", "X-ShopMate-Request": "1" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    if (body !== undefined) {
      throw unknownMutation();
    }
    throw new RequestError("无法连接服务，请稍后重试", "read-failed");
  }
  let data;
  try {
    data = await response.json();
  } catch {
    if (body !== undefined) {
      throw unknownMutation(response.status);
    }
    throw new RequestError(
      "服务响应异常，请稍后重试",
      "read-failed",
      response.status,
    );
  }
  if (!response.ok) {
    if (response.status === 401 && !url.startsWith("/api/state"))
      await refreshState().catch(() => undefined);
    throw new RequestError(
      data?.message ?? "请求失败",
      "rejected",
      response.status,
    );
  }
  return data as T;
}
export async function refreshState(role: Role = scope) {
  if (scope !== role) {
    database = emptyDatabase();
    hasSnapshot = false;
    confirmedNotice = "";
    issue = "";
    syncStatus = { role, phase: "unavailable" };
    notify();
  }
  scope = role;
  const current = ++sequence;
  try {
    const value = await request<{
      db: Database;
      sessions: Record<Role, Session | null>;
    }>(`/api/state?role=${role}`);
    if (
      !value?.db ||
      !Array.isArray(value.db.orders) ||
      !value.sessions ||
      !("user" in value.sessions) ||
      !("admin" in value.sessions) ||
      !validSession(value.sessions.user, "user") ||
      !validSession(value.sessions.admin, "admin")
    )
      throw new RequestError("服务状态响应异常，请重新连接", "read-failed");
    if (current === sequence) {
      database = value.db;
      sessions = value.sessions;
      if (sessions.user) confirmedLogouts.delete("user");
      if (sessions.admin) confirmedLogouts.delete("admin");
      issue = "";
      confirmedNotice = "";
      hasSnapshot = true;
      syncStatus = { role, phase: "ready" };
      notify();
    }
    return value;
  } catch (error) {
    if (current === sequence) {
      connectionIssue(
        error instanceof Error ? error.message : "无法读取服务端数据",
      );
    }
    throw error;
  }
}
if (typeof window !== "undefined") {
  window.setInterval(() => {
    if (!document.hidden) void refreshState().catch(() => undefined);
  }, 2000);
  window.addEventListener(
    "focus",
    () => void refreshState().catch(() => undefined),
  );
}
