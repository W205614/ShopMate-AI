import type { ShopApi } from "../domain/api";
import type { Role, Session, StockAdjustmentResult } from "../domain/types";
import {
  request,
  confirmSession,
  synchronizeConfirmedMutation,
  requireFreshState,
  unknownMutation,
  invalidateIdentitySnapshot,
  RequestError,
  getSession,
  getSyncStatus,
} from "./repository";
export {
  getDatabase,
  getMemberSummary,
  getStorageIssue,
  getSession,
  subscribeDatabase,
  refreshState,
  getSyncStatus,
  hasConfirmedLogout,
  RequestError,
  getCollectionPage,
  setRouteScope,
  routeCollection,
} from "./repository";
export type { ShopApi } from "../domain/api";

// Retain until the next user login: route guards may refresh sessions during redirect.
let passwordChanged = false;
const commandStorageKey = "shopmate:pending-commands";
const inFlightCommands = new Set<string>();
interface PendingCommand {
  fingerprint: string;
  requestId: string;
  method: string;
  role: Role;
  actorId: string;
}
function removePendingCommands(matches: (entry: PendingCommand) => boolean) {
  // Other commands may have started since this request was sent.
  const current = JSON.parse(
    sessionStorage.getItem(commandStorageKey) ?? "[]",
  ) as PendingCommand[];
  if (!Array.isArray(current))
    throw new Error("请求恢复记录损坏，请核对已提交记录");
  sessionStorage.setItem(
    commandStorageKey,
    JSON.stringify(current.filter((entry) => !matches(entry))),
  );
}
export function getPendingCommands() {
  try {
    const pending = JSON.parse(
      sessionStorage.getItem(commandStorageKey) ?? "[]",
    ) as PendingCommand[];
    const role = getSyncStatus().role,
      actorId = getSession(role)?.id;
    return Array.isArray(pending)
      ? pending.filter(
          (entry) => entry.role === role && entry.actorId === actorId,
        )
      : [];
  } catch {
    return [];
  }
}
export async function resolvePendingCommand(command: PendingCommand) {
  const result = await request<{ found: boolean }>(
    `/api/requests/${encodeURIComponent(command.requestId)}?method=${encodeURIComponent(command.method)}&role=${command.role}`,
  );
  if (result.found) {
    removePendingCommands((entry) => entry.fingerprint === command.fingerprint);
    await synchronizeConfirmedMutation();
  }
  return result.found;
}
export function hasPasswordChangeNotice() {
  return passwordChanged;
}

export async function commerceAction<T = void>(
  method: string,
  ...args: unknown[]
): Promise<T> {
  return action<T>(method, args);
}
async function action<T>(
  method: string,
  args: unknown[],
  validate?: (value: T) => boolean,
): Promise<T> {
  requireFreshState();
  args = JSON.parse(JSON.stringify(args)) as unknown[];
  const role = getSyncStatus().role;
  const actorId = getSession(role)?.id ?? "anonymous";
  const assertIdentity = () => {
    if (
      getSyncStatus().role !== role ||
      (getSession(role)?.id ?? "anonymous") !== actorId
    )
      throw new Error("登录身份已变化，请重新核对后操作");
  };
  const encoder = new TextEncoder();
  let fingerprintBytes = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(JSON.stringify([role, actorId, method, args])),
  );
  assertIdentity();
  const staffPassword = (args[0] as { password?: unknown } | undefined)
    ?.password;
  if (
    method === "saveStaff" &&
    typeof staffPassword === "string" &&
    staffPassword.length
  ) {
    // A persisted fast digest would allow inexpensive offline password guesses.
    // Keep the intermediate SHA in memory and persist only the slow derivation.
    const key = await crypto.subtle.importKey(
      "raw",
      fingerprintBytes,
      "PBKDF2",
      false,
      ["deriveBits"],
    );
    fingerprintBytes = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        iterations: 600_000,
        salt: encoder.encode(
          JSON.stringify([
            "shopmate:pending-command:v2",
            role,
            actorId,
            method,
          ]),
        ),
      },
      key,
      256,
    );
  }
  const fingerprint = Array.from(new Uint8Array(fingerprintBytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  assertIdentity();
  const storageKey = commandStorageKey;
  let pending: PendingCommand[];
  try {
    pending = JSON.parse(
      sessionStorage.getItem(storageKey) ?? "[]",
    ) as PendingCommand[];
  } catch {
    throw new Error("无法读取请求恢复记录，请先恢复浏览器会话存储");
  }
  if (!Array.isArray(pending))
    throw new Error("请求恢复记录损坏，请核对已提交记录");
  const previous = pending.find((entry) => entry.fingerprint === fingerprint);
  const otherPending = pending.find(
    (entry) =>
      entry.role === role &&
      entry.actorId === (getSession(role)?.id ?? "anonymous") &&
      entry.method === method &&
      entry.fingerprint !== fingerprint &&
      !inFlightCommands.has(entry.fingerprint),
  );
  if (otherPending) {
    const completed = await resolvePendingCommand(otherPending);
    throw new Error(
      completed
        ? "上次操作已完成，请核对最新记录后再提交新操作"
        : "原请求结果尚未确认，不能更改参数再次提交；请先核对上次提交或使用原参数重试",
    );
  }
  const businessRequestId =
    method === "adjustStock"
      ? (args[5] as { requestId?: string } | undefined)?.requestId
      : method === "createOrder"
        ? (args[0] as { requestId?: string } | undefined)?.requestId
        : undefined;
  const marker = previous ?? {
    fingerprint,
    requestId: businessRequestId ?? crypto.randomUUID(),
    method,
    role,
    actorId,
  };
  const clear = () =>
    removePendingCommands((entry) => entry.fingerprint === marker.fingerprint);
  if (!previous) {
    pending.push(marker);
    sessionStorage.setItem(storageKey, JSON.stringify(pending));
  }
  let response: { result: T };
  inFlightCommands.add(fingerprint);
  try {
    const resolved = previous
      ? await request<{ found: boolean; result?: T }>(
          `/api/requests/${encodeURIComponent(marker.requestId)}?method=${encodeURIComponent(method)}&role=${role}`,
        )
      : undefined;
    assertIdentity();
    response = resolved?.found
      ? { result: resolved.result as T }
      : await request<{ result: T }>(`/api/actions/${method}`, {
          args,
          requestId: marker.requestId,
        });
  } catch (error) {
    if (error instanceof RequestError && error.outcome === "rejected") clear();
    throw error;
  } finally {
    inFlightCommands.delete(fingerprint);
  }
  if (
    !response ||
    !Object.hasOwn(response, "result") ||
    (validate && !validate(response.result))
  )
    throw unknownMutation();
  clear();
  await synchronizeConfirmedMutation();
  return response.result;
}
export const api: ShopApi = {
  async login(role: Role, username: string, password: string) {
    invalidateIdentitySnapshot(role);
    const session = await request<Session>("/api/auth/login", {
      role,
      username,
      password,
    });
    if (!session) throw unknownMutation();
    if (role === "user") passwordChanged = false;
    confirmSession(role, session);
    await synchronizeConfirmedMutation();
    return session;
  },
  async register(input) {
    invalidateIdentitySnapshot("user");
    const session = await request<Session>("/api/auth/register", input);
    if (!session) throw unknownMutation();
    passwordChanged = false;
    confirmSession("user", session);
    await synchronizeConfirmedMutation();
    return session;
  },
  async logout(role) {
    const result = await request<{ ok: boolean }>("/api/auth/logout", {
      role,
    }).catch((error) => {
      if (error instanceof RequestError && error.outcome === "unknown")
        invalidateIdentitySnapshot(role);
      throw error;
    });
    if (result?.ok !== true) {
      invalidateIdentitySnapshot(role);
      throw unknownMutation();
    }
    confirmSession(role, null);
    await synchronizeConfirmedMutation();
  },
  async updateProfile(name) {
    requireFreshState();
    const session = await request<Session>("/api/auth/profile", { name });
    if (!session) throw unknownMutation();
    confirmSession("user", session, false);
    await synchronizeConfirmedMutation();
    return session;
  },
  async changePassword(currentPassword, newPassword) {
    requireFreshState();
    const result = await request<{ ok: boolean }>("/api/auth/password", {
      currentPassword,
      newPassword,
    }).catch((error) => {
      if (error instanceof RequestError && error.outcome === "unknown")
        invalidateIdentitySnapshot("user");
      throw error;
    });
    if (result?.ok !== true) {
      invalidateIdentitySnapshot("user");
      throw unknownMutation();
    }
    passwordChanged = true;
    confirmSession("user", null);
    await synchronizeConfirmedMutation();
  },
  batchCart: (...args) => action("batchCart", args),
  clearInvalidCart: (...args) => action("clearInvalidCart", args),
  quoteCheckout: (...args) => action("quoteCheckout", args),
  reorder: (...args) => action("reorder", args),
  saveCoupon: (...args) => action("saveCoupon", args),
  claimCoupon: (...args) => action("claimCoupon", args),
  toggleCoupon: (...args) => action("toggleCoupon", args),
  submitReview: (...args) => action("submitReview", args),
  deleteReview: (...args) => action("deleteReview", args),
  moderateReview: (...args) => action("moderateReview", args),
  cancelAfterSale: (...args) => action("cancelAfterSale", args),
  submitReturn: (...args) => action("submitReturn", args),
  addCart: (...args) => action("addCart", args),
  updateCart: (...args) => action("updateCart", args),
  removeCart: (...args) => action("removeCart", args),
  favorite: (...args) => action("favorite", args),
  saveAddress: (...args) => action("saveAddress", args),
  deleteAddress: (...args) => action("deleteAddress", args),
  async createOrder(input) {
    const result = await action<unknown>("createOrder", [input]);
    if (typeof result !== "string" || !result) throw unknownMutation();
    return result;
  },
  async resolveOrderRequest(input) {
    const actorId = getSession("user")?.id;
    const result = await request<{ orderId: string | null }>(
      `/api/order-requests/${encodeURIComponent(input.requestId)}?quoteId=${encodeURIComponent(input.quoteId)}`,
    );
    if (
      !result ||
      (result.orderId !== null &&
        (typeof result.orderId !== "string" || !result.orderId))
    )
      throw new Error("无法确认原请求结果，请重新核对");
    if (result.orderId)
      removePendingCommands(
        (entry) =>
          entry.role === "user" &&
          entry.actorId === actorId &&
          entry.method === "createOrder" &&
          entry.requestId === input.requestId,
      );
    return result.orderId;
  },
  async retireCheckout(input) {
    const actorId = getSession("user")?.id;
    const result = await action<unknown>("retireCheckout", [input]);
    if (result !== null && (typeof result !== "string" || !result))
      throw unknownMutation();
    removePendingCommands(
      (entry) =>
        entry.role === "user" &&
        entry.actorId === actorId &&
        entry.method === "createOrder" &&
        entry.requestId === input.requestId,
    );
    return result;
  },
  payOrder: (...args) => action("payOrder", args),
  cancelOrder: (...args) => action("cancelOrder", args),
  confirmOrder: (...args) => action("confirmOrder", args),
  requestAfterSale: (...args) => action("requestAfterSale", args),
  saveProduct: (...args) => action("saveProduct", args),
  toggleProduct: (...args) => action("toggleProduct", args),
  saveCategory: (...args) => action("saveCategory", args),
  deleteCategory: (...args) => action("deleteCategory", args),
  adjustStock: (...args) =>
    action<StockAdjustmentResult>(
      "adjustStock",
      args,
      (result) =>
        !!result &&
        typeof result.movementId === "string" &&
        result.movementId.length > 0 &&
        result.movementId.length <= 100 &&
        [result.beforeStock, result.afterStock, result.delta].every(
          Number.isSafeInteger,
        ) &&
        result.beforeStock >= 0 &&
        result.afterStock >= 0 &&
        result.beforeStock + result.delta === result.afterStock,
    ),
  shipOrder: (...args) => action("shipOrder", args),
  processAfterSale: (...args) => action("processAfterSale", args),
  createConversation: (...args) => action("createConversation", args),
  sendMessage: (...args) => action("sendMessage", args),
  transferConversation: (...args) => action("transferConversation", args),
  replyConversation: (...args) => action("replyConversation", args),
  closeConversation: (...args) => action("closeConversation", args),
  saveFaq: (...args) => action("saveFaq", args),
  deleteFaq: (...args) => action("deleteFaq", args),
  saveSettings: (...args) => action("saveSettings", args),
  resetDemo: (...args) => action("resetDemo", args),
  retryJob: (...args) => action("retryJob", args),
};
