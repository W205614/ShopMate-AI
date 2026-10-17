import type { ShopApi } from "../domain/api";
import type { Role, Session } from "../domain/types";
import { request, refreshState } from "./repository";
export {
  getDatabase,
  getStorageIssue,
  getSession,
  subscribeDatabase,
  refreshState,
} from "./repository";
export type { ShopApi } from "../domain/api";

// Retain until the next user login: route guards may refresh sessions during redirect.
let passwordChanged = false;
export function hasPasswordChangeNotice() {
  return passwordChanged;
}

async function action<T>(method: string, args: unknown[]): Promise<T> {
  const response = await request<{ result: T }>(`/api/actions/${method}`, {
    args,
  });
  await refreshState();
  return response.result;
}
export const api: ShopApi = {
  async login(role: Role, username: string, password: string) {
    const session = await request<Session>("/api/auth/login", {
      role,
      username,
      password,
    });
    if (role === "user") passwordChanged = false;
    await refreshState();
    return session;
  },
  async register(input) {
    const session = await request<Session>("/api/auth/register", input);
    passwordChanged = false;
    await refreshState();
    return session;
  },
  async logout(role) {
    await request("/api/auth/logout", { role });
    await refreshState();
  },
  async updateProfile(name) {
    const session = await request<Session>("/api/auth/profile", { name });
    await refreshState();
    return session;
  },
  async changePassword(currentPassword, newPassword) {
    await request("/api/auth/password", { currentPassword, newPassword });
    passwordChanged = true;
    await refreshState();
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
  createOrder: (...args) => action("createOrder", args),
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
