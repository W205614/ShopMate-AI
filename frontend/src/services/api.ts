import type { ShopApi } from "../domain/api";
import type { Role, Session } from "../domain/types";
import {
  request,
  confirmSession,
  synchronizeConfirmedMutation,
  requireFreshState,
  unknownMutation,
  invalidateIdentitySnapshot,
  RequestError,
} from "./repository";
export {
  getDatabase,
  getStorageIssue,
  getSession,
  subscribeDatabase,
  refreshState,
  getSyncStatus,
  hasConfirmedLogout,
  RequestError,
} from "./repository";
export type { ShopApi } from "../domain/api";

// Retain until the next user login: route guards may refresh sessions during redirect.
let passwordChanged = false;
export function hasPasswordChangeNotice() {
  return passwordChanged;
}

async function action<T>(method: string, args: unknown[]): Promise<T> {
  requireFreshState();
  const response = await request<{ result: T }>(`/api/actions/${method}`, {
    args,
  });
  if (!response || !Object.hasOwn(response, "result")) throw unknownMutation();
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
    const result = await request<{ orderId: string | null }>(
      `/api/order-requests/${encodeURIComponent(input.requestId)}?quoteId=${encodeURIComponent(input.quoteId)}`,
    );
    if (
      !result ||
      (result.orderId !== null &&
        (typeof result.orderId !== "string" || !result.orderId))
    )
      throw new Error("无法确认原请求结果，请重新核对");
    return result.orderId;
  },
  async retireCheckout(input) {
    const result = await action<unknown>("retireCheckout", [input]);
    if (result !== null && (typeof result !== "string" || !result))
      throw unknownMutation();
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
  adjustStock: (...args) => action("adjustStock", args),
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
};
