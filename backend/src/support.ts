import type { ShopApi } from "../../shared/domain/api";
import type { Message } from "../../shared/domain/types";
import { aiConfig } from "./ai-provider";
import { enqueueSupportRun } from "./ai-support";
import { cancelSupportWork, ensureSupportSchema } from "./ai-schema";
import { context } from "./repository";
import {
  transact,
  userId,
  ownedOrder,
  requireThat,
  id,
  now,
  text,
  admin,
} from "./repository";

export const supportApi: Pick<
  ShopApi,
  | "createConversation"
  | "sendMessage"
  | "transferConversation"
  | "replyConversation"
  | "closeConversation"
  | "saveFaq"
  | "deleteFaq"
> = {
  async createConversation(context = {}) {
    return transact((db) => {
      const uid = userId();
      if (context.orderId) ownedOrder(db, context.orderId);
      const product = context.productId
        ? db.products.find((p) => p.id === context.productId && p.active)
        : undefined;
      requireThat(!context.productId || product, "咨询的商品不存在或已下架");
      const conversationId = id("chat-");
      db.conversations.unshift({
        id: conversationId,
        userId: uid,
        ...context,
        title:
          product?.name ??
          (context.orderId ? `订单 ${context.orderId}` : "购物与服务咨询"),
        status: "bot",
        createdAt: now(),
        messages: [
          {
            id: id("msg-"),
            role: "assistant",
            text: aiConfig().enabled
              ? "你好，我是 ShopMate AI 客服。我可以帮你选商品、查询本人订单和售后，或根据已发布资料回答问题。业务操作需要你点击确认；支付、物流和退款均为模拟。"
              : "你好，我是 ShopMate 模拟客服。我可以帮你找商品、查看当前账号的演示订单，或指引售后。回复来自本地规则，信息不足时可以转人工。",
            createdAt: now(),
            ...(product ? { productIds: [product.id] } : {}),
            ...(context.orderId ? { orderId: context.orderId } : {}),
          },
        ],
      });
      return conversationId;
    });
  },
  async sendMessage(conversationId, message) {
    await transact((db) => {
      const conversation = db.conversations.find(
        (c) => c.id === conversationId && c.userId === userId(),
      );
      requireThat(
        conversation && conversation.status !== "closed",
        "会话不存在或已关闭，请新建咨询",
      );
      requireThat(text(message, 1000), "消息不能为空且不能超过 1000 字");
      const messageId = id("msg-");
      conversation.messages.push({
        id: messageId,
        role: "user",
        text: message.trim(),
        createdAt: now(),
      });
      if (conversation.status !== "bot") return;
      if (aiConfig().enabled) {
        enqueueSupportRun(
          context.getStore()!.sql,
          conversation.id,
          userId(),
          messageId,
        );
        return;
      }
      const answer: Message = {
        id: id("msg-"),
        role: "assistant",
        text: "",
        source: "rule",
        createdAt: now(),
      };
      const faq = db.faqs.find(
        (f) =>
          f.active &&
          f.keywords.some((k) => k.trim() && message.includes(k.trim())),
      );
      if (faq) answer.text = faq.answer;
      else if (/订单|物流|进度/.test(message)) {
        const orders = db.orders.filter((o) => o.userId === userId());
        const order =
          orders.find((o) => o.id === conversation.orderId) ?? orders[0];
        answer.text = order
          ? `你的演示订单 ${order.id} 可在订单详情中查看最新状态与物流。此处不会查询其他账号的订单。`
          : "当前账号暂无演示订单。可以先去商城选择商品。";
        if (order) answer.orderId = order.id;
      } else if (
        conversation.productId &&
        /规格|材质|介绍|什么|价格|多少钱|库存|有货/.test(message)
      ) {
        const product = db.products.find(
          (p) => p.id === conversation.productId && p.active,
        );
        answer.text = product
          ? `${product.name}：${product.description} 材质：${product.material}。当前可选规格：${product.skus.map((s) => `${s.name}，¥${(s.price / 100).toFixed(2)}，库存 ${s.stock}`).join("；")}。请在商品详情确认规格与最新价格。`
          : "该商品已下架，请查看其他商品或转人工。";
        if (product) answer.productIds = [product.id];
      } else {
        const budgetMatch = message.match(/(\d+(?:\.\d{1,2})?)\s*元/);
        const budget = budgetMatch ? Number(budgetMatch[1]) * 100 : Infinity;
        const keywords = message
          .replace(/[，。！？、\s]/g, "")
          .replace(/推荐|想买|有没有|帮我|以下|以内|预算|\d+元/g, "")
          .trim();
        const products = db.products
          .filter(
            (p) =>
              p.active &&
              p.skus.some((s) => s.stock > 0 && s.price <= budget) &&
              keywords.length > 0 &&
              [
                p.name,
                p.subtitle,
                p.description,
                db.categories.find((c) => c.id === p.categoryId)?.name ?? "",
              ].some(
                (t) =>
                  keywords.includes(t.slice(0, 2)) ||
                  t.includes(keywords) ||
                  keywords.split("").filter((ch) => t.includes(ch)).length >= 2,
              ),
          )
          .slice(0, 3);
        answer.text = products.length
          ? "根据商品名称、分类与预算的本地规则，找到这些演示商品。请打开详情核对规格；推荐不代表专业或安全保证。"
          : "目前的本地规则无法可靠回答这个问题。你可以补充商品名称、品类或“预算 100 元”，也可以点击转人工。";
        if (products.length) answer.productIds = products.map((p) => p.id);
      }
      conversation.messages.push(answer);
    });
  },
  async transferConversation(conversationId) {
    await transact((db) => {
      const conversation = db.conversations.find(
        (c) => c.id === conversationId && c.userId === userId(),
      );
      requireThat(
        conversation && conversation.status !== "closed",
        "会话不存在或已关闭",
      );
      if (conversation.status !== "bot") return;
      ensureSupportSchema(context.getStore()!.sql);
      cancelSupportWork(context.getStore()!.sql, conversationId);
      conversation.status = "waiting";
      conversation.messages.push({
        id: id("msg-"),
        role: "assistant",
        text: "已转入演示人工服务队列。请在管理端客服工作台回复，此处会同步显示。",
        createdAt: now(),
      });
    });
  },
  async replyConversation(conversationId, message) {
    await transact((db) => {
      admin();
      const conversation = db.conversations.find(
        (c) => c.id === conversationId,
      );
      requireThat(
        conversation && ["waiting", "human"].includes(conversation.status),
        "请先由用户转人工；已关闭会话不能回复",
      );
      requireThat(text(message, 1000), "回复不能为空且不能超过 1000 字");
      conversation.status = "human";
      conversation.messages.push({
        id: id("msg-"),
        role: "agent",
        text: message.trim(),
        createdAt: now(),
      });
    });
  },
  async closeConversation(conversationId) {
    await transact((db) => {
      admin();
      const conversation = db.conversations.find(
        (c) => c.id === conversationId,
      );
      requireThat(conversation, "会话不存在");
      ensureSupportSchema(context.getStore()!.sql);
      cancelSupportWork(context.getStore()!.sql, conversationId);
      conversation.status = "closed";
    });
  },
  async saveFaq(input) {
    await transact((db) => {
      admin();
      requireThat(
        text(input.question, 100) &&
          text(input.answer, 2000) &&
          input.keywords.length &&
          input.keywords.every((k) => text(k, 60)),
        "请填写问题、有效关键词及答案",
      );
      const old = input.id ? db.faqs.find((f) => f.id === input.id) : undefined;
      requireThat(!input.id || old, "问答不存在");
      const value = {
        ...input,
        id: old?.id ?? id("faq-"),
        keywords: [...new Set(input.keywords.map((k) => k.trim()))],
      };
      if (old) Object.assign(old, value);
      else db.faqs.push(value);
    });
  },
  async deleteFaq(faqId) {
    await transact((db) => {
      admin();
      db.faqs = db.faqs.filter((f) => f.id !== faqId);
    });
  },
};
