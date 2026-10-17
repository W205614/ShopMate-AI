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
    await refreshState();
    return session;
  },
  async register(input) {
    const session = await request<Session>("/api/auth/register", input);
    await refreshState();
    return session;
  },
  async logout(role) {
    await request("/api/auth/logout", { role });
    await refreshState();
  },
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
