import type {
  AddressInput,
  CheckoutInput,
  CheckoutQuote,
  CouponInput,
  ReorderResult,
  CategoryInput,
  FaqInput,
  ProductInput,
  Role,
  Session,
  Settings,
  StockAdjustmentOptions,
  StockAdjustmentResult,
} from "./types";

export interface ShopApi {
  register(input: {
    username: string;
    name: string;
    password: string;
  }): Promise<Session>;
  login(role: Role, username: string, password: string): Promise<Session>;
  logout(role: Role): Promise<void>;
  updateProfile(name: string): Promise<Session>;
  changePassword(currentPassword: string, newPassword: string): Promise<void>;
  batchCart(input: {
    ids: string[];
    action: "select" | "remove";
    selected?: boolean;
  }): Promise<void>;
  clearInvalidCart(): Promise<void>;
  quoteCheckout(input: CheckoutInput): Promise<CheckoutQuote>;
  reorder(id: string): Promise<ReorderResult>;
  saveCoupon(input: CouponInput): Promise<void>;
  claimCoupon(id: string): Promise<void>;
  toggleCoupon(id: string): Promise<void>;
  submitReview(input: {
    orderId: string;
    orderItemId: string;
    rating: number;
    content: string;
  }): Promise<void>;
  deleteReview(id: string): Promise<void>;
  moderateReview(id: string, hidden: boolean): Promise<void>;
  cancelAfterSale(id: string): Promise<void>;
  submitReturn(id: string, carrier: string, tracking: string): Promise<void>;
  addCart(productId: string, skuId: string, quantity: number): Promise<void>;
  updateCart(
    id: string,
    patch: { quantity?: number; selected?: boolean },
  ): Promise<void>;
  removeCart(id: string): Promise<void>;
  favorite(productId: string): Promise<void>;
  saveAddress(input: AddressInput): Promise<void>;
  deleteAddress(id: string): Promise<void>;
  createOrder(input: { quoteId: string; requestId: string }): Promise<string>;
  resolveOrderRequest(input: {
    quoteId: string;
    requestId: string;
  }): Promise<string | null>;
  retireCheckout(input: {
    quoteId: string;
    requestId: string;
  }): Promise<string | null>;
  payOrder(id: string): Promise<void>;
  cancelOrder(id: string): Promise<void>;
  confirmOrder(id: string): Promise<void>;
  requestAfterSale(
    orderId: string,
    reason: string,
    description: string,
    lines: { orderItemId: string; quantity: number }[],
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
    options?: StockAdjustmentOptions,
  ): Promise<StockAdjustmentResult>;
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
  saveSettings(
    input: Settings,
    baseline: Settings,
  ): Promise<{ settings: Settings; revision: number }>;
  resetDemo(): Promise<void>;
}
