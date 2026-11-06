export type PaymentChannel =
  "wechat_native" | "wechat_h5" | "alipay_page" | "alipay_wap";
export type PaymentProvider = "wechatpay" | "alipay";
export type PaymentStatus =
  "creating" | "pending" | "unknown" | "succeeded" | "closed" | "failed";
export type RefundStatus =
  "pending" | "unknown" | "processing" | "succeeded" | "failed" | "abnormal";
export interface Payment {
  id: string;
  orderId: string;
  userId: string;
  channel: PaymentChannel;
  provider: PaymentProvider;
  merchantId: string;
  amount: number;
  currency: "CNY";
  status: PaymentStatus;
  closeRequested: boolean;
  checkout?: { kind: "qr" | "redirect"; value: string; expiresAt?: string };
  providerTransactionId?: string;
  errorCode?: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
}
export interface Refund {
  noTransfer?: boolean;
  id: string;
  paymentId: string;
  orderId: string;
  afterSaleId: string;
  provider: PaymentProvider;
  amount: number;
  status: RefundStatus;
  providerRefundId?: string;
  errorCode?: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
}
export interface ProductionCapabilities {
  mode: "demo" | "production";
  paymentChannels: PaymentChannel[];
  emailEnabled: boolean;
  smsEnabled: boolean;
}
