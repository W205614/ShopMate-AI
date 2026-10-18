import type { Database, Role, Session } from "../domain/types";
import { readCatalogueQuery } from "../domain/catalogue";
import type { LocationQuery } from "vue-router";
import type { MemberSummary } from "../../../shared/domain/operations";
const emptyDatabase = (): Database => ({
  version: 3,
  inventoryRequests: [],
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
const emptyMemberSummary = (): MemberSummary => ({
  orderCount: 0,
  afterSaleCount: 0,
  couponClaimCount: 0,
  favoriteCount: 0,
  cartQuantity: 0,
});
let memberSummary = emptyMemberSummary();
export const getMemberSummary = () => ({ ...memberSummary });
let sessions: Record<Role, Session | null> = { user: null, admin: null };
let issue = "";
let scope: Role = "user";
let sequence = 0;
let hasSnapshot = false;
let routePath = "/";
let routeQuery: Record<string, unknown> = {};
export interface CollectionPage {
  total: number;
  page: number;
  pageSize: number;
  pages: number;
  ids?: string[];
  totals?: { payment: string; refund: string; purchase: string; net: string };
}
let collectionPages: Record<string, CollectionPage> = {};
export const getCollectionPage = (name: string) => collectionPages[name];
export function setRouteScope(path: string, query: Record<string, unknown>) {
  routePath = path;
  routeQuery = { ...query };
}
export function routeCollection(path = routePath): string | undefined {
  const segment = path.split("/").filter(Boolean);
  const name = segment[segment[0] === "admin" ? 1 : 0] ?? "";
  return (
    {
      products: "products",
      categories: "categories",
      orders: "orders",
      "after-sales": "afterSales",
      inventory: routeQuery.tab === "records" ? "inventory" : "products",
      coupons: "coupons",
      reviews: "reviews",
      finance: "ledger",
      support: "conversations",
      knowledge: "faqs",
      operations: [
        "shippingRules",
        "promotions",
        "suppliers",
        "purchaseOrders",
        "returnInspections",
        "auditEntries",
        "staff",
        "reconciliation",
        "jobs",
      ].includes(String(routeQuery.tab))
        ? String(routeQuery.tab)
        : "",
      notifications: "notifications",
      points: "pointsEntries",
    } as Record<string, string>
  )[name];
}
function collectionTargets(role: Role) {
  const primary = routeCollection();
  const targets = new Set<string>(primary ? [primary] : []);
  if (role === "user") {
    if (
      routePath === "/cart" ||
      (routePath === "/checkout" && !routeQuery.productId)
    )
      targets.add("carts");
    if (routePath === "/checkout" && routeQuery.productId)
      targets.add("products");
    if (routePath === "/account") {
      const section = routeQuery.section;
      if (section === "reviews") targets.add("reviews");
      if (section === "addresses") targets.add("addresses");
      if (section === "coupons") targets.add("couponClaims");
      if (section === "pending-reviews") {
        targets.add("orders");
      }
      if (!section || section === "overview") targets.add("products");
    }
  }
  return [...targets].filter(
    (name) => !["staff", "reconciliation", "jobs"].includes(name),
  );
}
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
    memberSummary = emptyMemberSummary();
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
    memberSummary = emptyMemberSummary();
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
    if (
      response.status === 401 &&
      !url.startsWith("/api/bootstrap") &&
      !url.startsWith("/api/collections/")
    )
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
    memberSummary = emptyMemberSummary();
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
      memberSummary?: MemberSummary | null;
    }>(`/api/bootstrap?role=${role}`);
    if (
      !value?.db ||
      !value.sessions ||
      !("user" in value.sessions) ||
      !("admin" in value.sessions) ||
      !validSession(value.sessions.user, "user") ||
      !validSession(value.sessions.admin, "admin")
    )
      throw new RequestError("服务状态响应异常，请重新连接", "read-failed");
    if (current === sequence) {
      const next = { ...emptyDatabase(), ...value.db };
      const pages: Record<string, CollectionPage> = {};
      const permittedTargets = collectionTargets(role).filter((name) => {
        if (role === "user" && routePath === "/account" && !value.sessions.user)
          return false;
        if (role === "admin") {
          const session = value.sessions.admin;
          if (!session) return false;
          const grants: Record<string, string[]> = {
            orders: ["warehouse", "support", "finance"],
            afterSales: ["warehouse", "support", "finance"],
            inventory: ["warehouse"],
            ledger: ["finance"],
            conversations: ["support"],
            shippingRules: ["settings"],
            suppliers: ["warehouse"],
            purchaseOrders: ["warehouse"],
            returnInspections: ["warehouse"],
            auditEntries: ["audit"],
          };
          return (
            !grants[name] ||
            grants[name].some((permission) =>
              session.permissions?.includes(permission),
            )
          );
        }
        return (
          !!value.sessions.user ||
          ["products", "categories", "coupons", "faqs", "promotions"].includes(
            name,
          )
        );
      });
      const results = await Promise.all(
        permittedTargets.map(async (name) => {
          const params = new URLSearchParams({
            role,
            page: String(routeQuery.page ?? 1),
            pageSize: routePath === "/products" ? "12" : "10",
          });
          if (
            role === "admin" &&
            routePath === "/admin/inventory" &&
            name === "products"
          )
            params.set("view", "inventory");
          for (const [key, raw] of Object.entries(routeQuery)) {
            if (typeof raw === "string" && key !== "page")
              params.set(key === "q" ? "search" : key, raw);
          }
          if (
            role === "user" &&
            routePath === "/products" &&
            name === "products"
          ) {
            const normalized = readCatalogueQuery(routeQuery as LocationQuery);
            for (const key of [
              "page",
              "sort",
              "search",
              "min",
              "max",
              "category",
              "stock",
            ])
              params.delete(key);
            params.set("page", String(normalized.page));
            params.set("sort", normalized.sort);
            if (normalized.q) params.set("search", normalized.q);
            if (normalized.category)
              params.set("category", normalized.category);
            if (normalized.min !== undefined)
              params.set("min", String(normalized.min / 100));
            if (normalized.max !== undefined)
              params.set("max", String(normalized.max / 100));
            if (normalized.inStock) params.set("stock", "1");
          }
          const segments = routePath.split("/").filter(Boolean);
          const detail = role === "admin" ? routeQuery.detail : segments[1];
          if (
            role !== "admin" &&
            typeof detail === "string" &&
            detail &&
            detail !== "pay"
          )
            params.set("id", detail);
          if (
            name === "products" &&
            routePath === "/checkout" &&
            typeof routeQuery.productId === "string"
          ) {
            params.delete("productId");
            params.set("id", routeQuery.productId);
          }
          if (
            name === "carts" &&
            routePath === "/checkout" &&
            typeof routeQuery.cartIds === "string"
          ) {
            params.set("id", routeQuery.cartIds);
            params.set("pageSize", "100");
          }
          if (routePath === "/account" && name === "products") {
            params.set("favorites", "1");
          }
          if (
            routePath === "/account" &&
            name === "orders" &&
            typeof routeQuery.orderId === "string"
          ) {
            params.delete("orderId");
            params.set("id", routeQuery.orderId);
          }
          const result = await request<
            CollectionPage & { items: unknown[]; related?: Partial<Database> }
          >(`/api/collections/${name}?${params}`);
          if (!Array.isArray(result.items))
            throw new RequestError("列表响应异常", "read-failed");
          const detailResult =
            role === "admin" && typeof detail === "string" && detail
              ? await request<{
                  items: unknown[];
                  related?: Partial<Database>;
                }>(
                  `/api/collections/${name}?role=${role}&id=${encodeURIComponent(detail)}&pageSize=1`,
                )
              : undefined;
          const ids = result.items.map((item) => (item as { id: string }).id);
          pages[name] = {
            total: result.total,
            page: result.page,
            pageSize: result.pageSize,
            pages: result.pages,
            ids,
            totals: result.totals,
          };
          const items = [
            ...result.items,
            ...(detailResult?.items ?? []).filter(
              (item) => !ids.includes((item as { id: string }).id),
            ),
          ];
          return {
            name,
            items,
            related: { ...result.related, ...detailResult?.related },
          };
        }),
      );
      // Merge referenced records first, then primary pages. Completion order of
      // concurrent reads must never replace a requested page with a related slice.
      for (const result of results) Object.assign(next, result.related);
      for (const result of results)
        Object.assign(next, { [result.name]: result.items });
      if (current !== sequence) return value;
      database = next;
      memberSummary = value.sessions.user
        ? (value.memberSummary ?? emptyMemberSummary())
        : emptyMemberSummary();
      value.db = next;
      collectionPages = pages;
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
  }, 2_000);
  window.addEventListener(
    "focus",
    () => void refreshState().catch(() => undefined),
  );
}
