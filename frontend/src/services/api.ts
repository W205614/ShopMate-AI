// Async demo boundary: UI modules share these contracts with a future HTTP adapter.
import type {
  AddressInput,
  CategoryInput,
  FaqInput,
  ProductInput,
  Role,
  Session,
  Settings,
} from "../domain/types";
import {
  admin,
  getDatabase,
  requireThat,
  SESSION_KEY,
  transact,
} from "./repository";
import { commerceApi } from "./commerce";
import { catalogApi } from "./catalog";
import { supportApi } from "./support";

export {
  getDatabase,
  getStorageIssue,
  getSession,
  subscribeDatabase,
  STORAGE_KEY,
} from "./repository";

export interface ShopApi {
  login(role: Role, username: string, password: string): Promise<Session>;
  logout(role: Role): Promise<void>;
  addCart(productId: string, skuId: string, quantity: number): Promise<void>;
  updateCart(
    id: string,
    patch: { quantity?: number; selected?: boolean },
  ): Promise<void>;
  removeCart(id: string): Promise<void>;
  favorite(productId: string): Promise<void>;
  saveAddress(input: AddressInput): Promise<void>;
  deleteAddress(id: string): Promise<void>;
  createOrder(addressId: string): Promise<string>;
  payOrder(id: string): Promise<void>;
  cancelOrder(id: string): Promise<void>;
  confirmOrder(id: string): Promise<void>;
  requestAfterSale(
    orderId: string,
    reason: string,
    description: string,
  ): Promise<void>;
  saveProduct(input: ProductInput): Promise<void>;
  toggleProduct(id: string): Promise<void>;
  saveCategory(input: CategoryInput): Promise<void>;
  deleteCategory(id: string): Promise<void>;
  adjustStock(
    productId: string,
    skuId: string,
    delta: number,
    cost: number,
    reason: string,
  ): Promise<void>;
  shipOrder(id: string, carrier: string, tracking: string): Promise<void>;
  processAfterSale(
    id: string,
    action: "approve" | "reject" | "receive" | "refund",
    note?: string,
  ): Promise<void>;
  createConversation(context?: {
    productId?: string;
    orderId?: string;
  }): Promise<string>;
  sendMessage(id: string, text: string): Promise<void>;
  transferConversation(id: string): Promise<void>;
  replyConversation(id: string, text: string): Promise<void>;
  closeConversation(id: string): Promise<void>;
  saveFaq(input: FaqInput): Promise<void>;
  deleteFaq(id: string): Promise<void>;
  saveSettings(input: Settings): Promise<void>;
  resetDemo(): Promise<void>;
}

export const api: ShopApi = {
  ...commerceApi,
  ...catalogApi,
  ...supportApi,
  async login(role, username, password) {
    requireThat(password === "demo123", "演示密码为 demo123");
    const user =
      role === "admin"
        ? username === "admin"
          ? { id: "admin", name: "商城管理员" }
          : null
        : getDatabase().users.find((u) => u.username === username);
    requireThat(
      user,
      role === "admin"
        ? "管理员演示账号为 admin"
        : "用户演示账号为 lin 或 chen",
    );
    const session: Session = { id: user.id, name: user.name, role };
    sessionStorage.setItem(SESSION_KEY + role, JSON.stringify(session));
    return session;
  },
  async logout(role) {
    sessionStorage.removeItem(SESSION_KEY + role);
  },
  async resetDemo() {
    admin();
    await transact(() => undefined, true);
  },
};
