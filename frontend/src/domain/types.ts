export type Role = "user" | "admin";
export interface Session {
  id: string;
  name: string;
  role: Role;
}
export interface User {
  id: string;
  username: string;
  name: string;
}
export interface Category {
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
export interface OrderItem {
  productId: string;
  skuId: string;
  name: string;
  skuName: string;
  image: string;
  price: number;
  quantity: number;
}
export interface Order {
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
  "requested" | "approved" | "received" | "refunded" | "rejected";
export interface AfterSale {
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
}
export interface LedgerEntry {
  id: string;
  type: "payment" | "refund" | "purchase";
  amount: number;
  reference: string;
  note: string;
  createdAt: string;
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
  name: string;
  slogan: string;
  notice: string;
}
export interface Database {
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
export type CategoryInput = Omit<Category, "id"> & { id?: string };
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
  received: "已收货",
  refunded: "已退款",
  rejected: "已拒绝",
};
export const money = (cents: number) =>
  "¥" +
  (cents / 100).toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
export const dateTime = (value: string) =>
  new Date(value).toLocaleString("zh-CN", { hour12: false });
