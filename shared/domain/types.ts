import type {
  ShippingRule,
  Promotion,
  PointsEntry,
  Supplier,
  PurchaseOrder,
  ReturnInspection,
  Notification,
  AuditEntry,
} from "./operations";
export type Role = "user" | "admin";
export interface Session {
  id: string;
  name: string;
  role: Role;
  permissions?: string[];
  staffRole?: "owner" | "operations" | "warehouse" | "support" | "finance";
}
export interface User {
  id: string;
  username: string;
  name: string;
}
export interface Category {
  productCount?: number;
  version?: number;
  id: string;
  name: string;
  description: string;
  image: string;
  sort: number;
}
export interface SKU {
  id: string;
  name: string;
  price: number;
  stock: number;
}
export interface Product {
  version?: number;
  id: string;
  name: string;
  subtitle: string;
  categoryId: string;
  description: string;
  images: string[];
  skus: SKU[];
  active: boolean;
  featured: boolean;
  material: string;
}
export interface CartItem {
  id: string;
  userId: string;
  productId: string;
  skuId: string;
  quantity: number;
  selected: boolean;
}
export interface Address {
  province?: string;
  id: string;
  userId: string;
  name: string;
  phone: string;
  region: string;
  detail: string;
  isDefault: boolean;
}
export type OrderStatus =
  "pending" | "paid" | "shipped" | "completed" | "cancelled" | "refunded";
export interface BusinessEvent {
  at: string;
  actor: "user" | "admin" | "system";
  action: string;
  note?: string;
}
export interface OrderItem {
  id: string;
  discount: number;
  total: number;
  refundedQuantity: number;
  productId: string;
  skuId: string;
  name: string;
  skuName: string;
  image: string;
  price: number;
  quantity: number;
}
export interface Order {
  inventoryPolicy?: "reserved-v1";
  shipping?: { ruleId: string; name: string; fee: number };
  shippingFee?: number;
  shippingRefunded?: number;
  promotion?: { id: string; name: string; discount: number };
  afterSaleDays?: number;
  pointsPolicy?: "earned-v1";
  pointsAwarded?: number;
  subtotal: number;
  discount: number;
  refundedAmount: number;
  events: BusinessEvent[];
  expiresAt?: string;
  completedAt?: string;
  cancelledAt?: string;
  cancelReason?: string;
  coupon?: { claimId: string; name: string; discount: number };
  quoteId?: string;
  id: string;
  userId: string;
  items: OrderItem[];
  total: number;
  status: OrderStatus;
  address: Address;
  createdAt: string;
  paidAt?: string;
  carrier?: string;
  tracking?: string;
  shippedAt?: string;
}
export type AfterSaleStatus =
  | "requested"
  | "approved"
  | "returning"
  | "received"
  | "refunded"
  | "rejected"
  | "cancelled";
export interface AfterSaleLine {
  orderItemId: string;
  quantity: number;
  amount: number;
}
export interface AfterSale {
  shippingRefund?: number;
  lines: AfterSaleLine[];
  refundAmount: number;
  events: BusinessEvent[];
  returnCarrier?: string;
  returnTracking?: string;
  id: string;
  orderId: string;
  userId: string;
  reason: string;
  description: string;
  status: AfterSaleStatus;
  requiresReturn: boolean;
  createdAt: string;
  note: string;
}
export interface InventoryMovement {
  id: string;
  productId: string;
  skuId: string;
  delta: number;
  reason: string;
  createdAt: string;
  beforeStock?: number;
  afterStock?: number;
  mode?: "delta" | "count";
}
export interface StockAdjustmentOptions {
  requestId: string;
  mode?: "delta" | "count";
  expectedStock?: number;
}
export interface StockAdjustmentResult {
  movementId: string;
  beforeStock: number;
  afterStock: number;
  delta: number;
}
export interface InventoryRequest {
  adminId: string;
  requestId: string;
  fingerprint: string;
  result: StockAdjustmentResult;
  createdAt: string;
}
export interface LedgerEntry {
  id: string;
  type: "payment" | "refund" | "purchase";
  amount: number;
  reference: string;
  note: string;
  createdAt: string;
  inventoryMovementId?: string;
}
export interface Message {
  id: string;
  role: "user" | "assistant" | "agent";
  text: string;
  createdAt: string;
  productIds?: string[];
  orderId?: string;
}
export interface Conversation {
  id: string;
  userId: string;
  title: string;
  productId?: string;
  orderId?: string;
  status: "bot" | "waiting" | "human" | "closed";
  messages: Message[];
  createdAt: string;
}
export interface Faq {
  id: string;
  question: string;
  keywords: string[];
  answer: string;
  active: boolean;
}
export interface Settings {
  version?: number;
  name: string;
  slogan: string;
  notice: string;
}
export interface Coupon {
  version?: number;
  claimedCount?: number;
  id: string;
  name: string;
  threshold: number;
  discount: number;
  claimStartsAt: string;
  claimEndsAt: string;
  validFrom: string;
  validUntil: string;
  totalLimit: number;
  active: boolean;
}
export type CouponInput = Omit<Coupon, "id" | "claimedCount"> & { id?: string };
export interface CouponClaim {
  id: string;
  userId: string;
  couponId: string;
  claimedAt: string;
  status: "available" | "locked" | "used";
  orderId?: string;
}
export interface Review {
  id: string;
  userId: string;
  orderId: string;
  orderItemId: string;
  productId: string;
  rating: number;
  content: string;
  createdAt: string;
  hidden: boolean;
  deleted: boolean;
}
export interface PublicReview {
  id: string;
  displayName: string;
  rating: number;
  content: string;
  createdAt: string;
}
export interface PublicReviews {
  items: PublicReview[];
  total: number;
  page: number;
  pages: number;
  averageRating: number;
}
export type CheckoutSource =
  | { type: "cart"; cartIds: string[] }
  | { type: "buyNow"; productId: string; skuId: string; quantity: number };
export interface CheckoutInput {
  source: CheckoutSource;
  addressId: string;
  couponClaimId?: string;
}
export interface CheckoutQuote {
  shipping?: { ruleId: string; name: string; fee: number };
  shippingFee?: number;
  promotion?: { id: string; name: string; discount: number };
  id: string;
  userId: string;
  input: CheckoutInput;
  items: OrderItem[];
  address: Address;
  subtotal: number;
  discount: number;
  total: number;
  createdAt: string;
  expiresAt: string;
  fingerprint: string;
  coupon?: { claimId: string; name: string; discount: number };
  orderId?: string;
}
export interface OrderRequest {
  userId: string;
  requestId: string;
  quoteId: string;
  orderId: string;
  createdAt: string;
}
export interface ReorderResult {
  added: number;
  addedQuantity: number;
  skipped: string[];
}
export interface Database {
  shippingRules?: ShippingRule[];
  promotions?: Promotion[];
  pointsEntries?: PointsEntry[];
  suppliers?: Supplier[];
  purchaseOrders?: PurchaseOrder[];
  returnInspections?: ReturnInspection[];
  notifications?: Notification[];
  auditEntries?: AuditEntry[];
  inventoryRequests: InventoryRequest[];
  coupons: Coupon[];
  couponClaims: CouponClaim[];
  reviews: Review[];
  checkoutQuotes: CheckoutQuote[];
  orderRequests: OrderRequest[];
  version: number;
  revision: number;
  users: User[];
  categories: Category[];
  products: Product[];
  carts: CartItem[];
  addresses: Address[];
  favorites: Record<string, string[]>;
  orders: Order[];
  afterSales: AfterSale[];
  inventory: InventoryMovement[];
  ledger: LedgerEntry[];
  conversations: Conversation[];
  faqs: Faq[];
  settings: Settings;
}
export type ProductInput = Omit<Product, "id"> & { id?: string };
export type CategoryInput = Omit<Category, "id" | "productCount"> & { id?: string };
export type AddressInput = Omit<Address, "id" | "userId"> & { id?: string };
export type FaqInput = Omit<Faq, "id"> & { id?: string };
export const orderLabels: Record<OrderStatus, string> = {
  pending: "待付款",
  paid: "待发货",
  shipped: "待收货",
  completed: "已完成",
  cancelled: "已取消",
  refunded: "已退款",
};
export const afterSaleLabels: Record<AfterSaleStatus, string> = {
  requested: "待审核",
  approved: "已批准",
  returning: "退货运输中",
  cancelled: "已撤销",
  received: "已收货",
  refunded: "已退款",
  rejected: "已拒绝",
};
export const money = (cents: number | bigint) => {
  const value = BigInt(cents),
    absolute = value < 0n ? -value : value;
  return `¥${value < 0n ? "-" : ""}${(absolute / 100n).toLocaleString("zh-CN")}.${String(absolute % 100n).padStart(2, "0")}`;
};
export const dateTime = (value: string) =>
  new Date(value).toLocaleString("zh-CN", { hour12: false });
