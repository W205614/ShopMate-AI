import type { Conversation, Product, Order } from "../domain/types";
import { request } from "./repository";

export interface SupportRun {
  id: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  phase: string;
  error?: string;
  degraded?: string[];
}
export interface SupportProposal {
  id: string;
  kind: "addCart" | "cancelOrder" | "requestAfterSale";
  summary: string;
  details: Record<string, unknown>;
  status: "pending" | "confirmed" | "cancelled" | "expired";
  expiresAt: string;
}
export interface SupportDetail {
  conversation: Conversation;
  run: SupportRun | null;
  proposals: SupportProposal[];
  aiEnabled: boolean;
  products?: Product[];
  orders?: Order[];
}
export const activeSupportRun = (run: SupportRun | null | undefined) =>
  run?.status === "queued" || run?.status === "running";
export function supportPhase(run: SupportRun) {
  if (run.status === "queued") return "排队中";
  return (
    (
      {
        retrieval: "检索中",
        retrieving: "检索中",
        searching: "检索中",
        tools: "查询中",
        querying: "查询中",
        generating: "生成中",
      } as Record<string, string>
    )[run.phase] ?? "处理中"
  );
}
export const getSupportDetail = (id: string) =>
  request<SupportDetail>(
    `/api/support/conversations/${encodeURIComponent(id)}`,
  );

export function supportFailure(code?: string) {
  return (
    (
      {
        AI_TIMEOUT: "本轮处理超时，你的消息已保留。",
        AI_LIMIT_REACHED: "本轮查询次数已达上限，请缩小问题范围或转人工。",
        AI_PROVIDER_FAILED: "AI 服务暂不可用，你的消息已保留。",
        AI_DISABLED: "AI 客服已关闭，请使用规则客服或转人工。",
      } as Record<string, string>
    )[code ?? ""] ?? "本轮生成失败，你的消息已保留。"
  );
}
export function supportDegradation(code: string) {
  return (
    (
      {
        embedding_model_changed: "知识索引正在更新，暂使用关键词检索",
        embedding_unavailable_keyword_only:
          "语义检索暂不可用，已使用关键词检索",
        reranker_unavailable_fusion_order: "精排暂不可用，已使用综合检索顺序",
      } as Record<string, string>
    )[code] ?? "部分知识检索能力暂不可用"
  );
}
