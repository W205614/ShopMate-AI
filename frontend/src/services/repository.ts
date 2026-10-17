import type { Database, Role, Session } from "../domain/types";
let database: Database = {
  version: 1,
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
};
let sessions: Record<Role, Session | null> = { user: null, admin: null };
let issue = "";
let scope: Role = "user";
let sequence = 0;
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
    throw new Error("无法连接服务，请稍后重试");
  }
  const data = await response
    .json()
    .catch(() => ({ message: "服务响应异常，请稍后重试" }));
  if (!response.ok) {
    if (response.status === 401) await refreshState().catch(() => undefined);
    throw new Error(data.message ?? "请求失败");
  }
  return data as T;
}
export async function refreshState(role: Role = scope) {
  scope = role;
  const current = ++sequence;
  try {
    const value = await request<{
      db: Database;
      sessions: Record<Role, Session | null>;
    }>(`/api/state?role=${role}`);
    if (current !== sequence) return;
    database = value.db;
    sessions = value.sessions;
    issue = "";
    notify();
  } catch (error) {
    if (current === sequence) {
      issue = error instanceof Error ? error.message : "无法读取服务端数据";
      sessions = { user: null, admin: null };
      notify();
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
