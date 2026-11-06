import { request } from "./repository";
import type {
  Payment,
  PaymentProvider,
  ProductionCapabilities,
  Refund,
} from "../../../shared/domain/production";

export interface Merchant {
  version: number;
  legalName: string;
  serviceEmail: string;
  servicePhone: string;
  returnAddress: string;
  privacy: { version: string; title: string; text: string };
  terms: { version: string; title: string; text: string };
}
export interface ProductionPage<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
}
export interface ProductionStatus {
  mode: "demo" | "production";
  paymentChannels: string[];
  integrations: Record<string, unknown>;
  counts: {
    paymentsUnknown: number;
    refundsPending: number;
    webhooksFailed: number;
    reconciliationDifferences: number;
  };
  externalAcceptance: "not_verified";
}
export interface ChannelReconciliation {
  id: string;
  provider: PaymentProvider;
  date: string;
  status: "pending" | "done" | "failed";
  differences: number;
  reviewed: boolean;
  createdAt: string;
  errorCode?: string;
}
export const productionApi = {
  capabilities: () => request<ProductionCapabilities>("/api/production/config"),
  merchant: () => request<Merchant>("/api/merchant"),
  status: () => request<ProductionStatus>("/api/admin/production/status"),
  payments: (page: number) =>
    request<ProductionPage<Payment>>(
      `/api/admin/payments?page=${page}&pageSize=20`,
    ),
  refunds: (page: number) =>
    request<ProductionPage<Refund>>(
      `/api/admin/refunds?page=${page}&pageSize=20`,
    ),
  reconciliation: (page: number) =>
    request<ProductionPage<ChannelReconciliation>>(
      `/api/admin/channel-reconciliation?page=${page}&pageSize=20`,
    ),
};
