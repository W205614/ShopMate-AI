import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";
import type {
  Database,
  Order,
  Session,
  LedgerEntry,
} from "../../shared/domain/types";
import {
  readDatabase,
  writeDatabase,
  transaction,
  initialDatabase,
} from "./database";
import { HttpError } from "./auth";
import { audit, enqueue } from "./runtime";
import type { DatabaseReadScope } from "./storage";
import { releaseSnapshot } from "./storage";

export const context = new AsyncLocalStorage<{
  sql: DatabaseSync;
  user: Session | null;
  admin: Session | null;
  afterSaleDays?: number;
  command?: {
    method: string;
    requestId: string;
    fingerprint: string;
    args: unknown[];
  };
}>();
export const clone = <T>(value: T): T => structuredClone(value);
export const id = (prefix: string) =>
  prefix + crypto.randomUUID().replaceAll("-", "");
export const now = () => new Date().toISOString();
export function requireThat(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new HttpError(400, message);
}
export const integer = (n: number, min = 0) =>
  Number.isSafeInteger(n) && n >= min;
export const text = (s: string, max = 500) =>
  typeof s === "string" && s.trim().length > 0 && s.trim().length <= max;
export function userId() {
  const session = context.getStore()?.user;
  if (!session) throw new HttpError(401, "请先登录用户账号");
  return session.id;
}
export function admin() {
  const session = context.getStore()?.admin;
  if (!session) throw new HttpError(401, "请先登录管理账号");
  return session;
}
export function getDatabase() {
  return readDatabase(context.getStore()!.sql);
}
type Command = NonNullable<
  NonNullable<ReturnType<typeof context.getStore>>["command"]
>;

/** Keep all pending reservations, but load historical orders only through an explicit command target. */
export function commandReadScope(
  sql: DatabaseSync,
  command: Command,
  user: Session | null,
): DatabaseReadScope {
  const ids = new Set<string>(),
    first = command.args[0];
  let proposalConversation: string | undefined;
  const add = (value: unknown) => {
    if (typeof value === "string" && value) ids.add(value);
  };
  const linkedOrder = (table: string, key: string) => {
    const row = sql
      .prepare(`SELECT order_id FROM ${table} WHERE key=?`)
      .get(key) as { order_id: string | null } | undefined;
    add(row?.order_id);
  };
  if (typeof first === "string") {
    if (command.method === "confirmSupportProposal") {
      const proposal = sql
        .prepare(
          "SELECT args,conversation_id FROM support_proposals WHERE id=? AND user_id=?",
        )
        .get(first, user?.id ?? "");
      if (proposal) {
        add(JSON.parse(String(proposal.args)).orderId);
        proposalConversation = String(proposal.conversation_id);
      }
    }
    if (
      [
        "payOrder",
        "cancelOrder",
        "confirmOrder",
        "reorder",
        "requestAfterSale",
        "shipOrder",
      ].includes(command.method)
    )
      add(first);
    else if (
      ["cancelAfterSale", "submitReturn", "processAfterSale"].includes(
        command.method,
      )
    )
      linkedOrder("biz_after_sales", first);
    else if (["moderateReview", "deleteReview"].includes(command.method))
      linkedOrder("biz_reviews", first);
    else if (
      command.method === "sendMessage" &&
      user &&
      typeof command.args[1] === "string" &&
      /订单|物流|进度/.test(command.args[1])
    ) {
      const conversation = sql
        .prepare(
          "SELECT user_id,order_id,status FROM biz_conversations WHERE key=?",
        )
        .get(first) as
        | { user_id: string; order_id: string | null; status: string }
        | undefined;
      if (conversation?.user_id === user.id && conversation.status === "bot") {
        add(conversation.order_id);
        // Preserve the rule-based assistant's original "first owned order" fallback without loading the history.
        add(
          (
            sql
              .prepare(
                "SELECT key FROM biz_orders WHERE user_id=? ORDER BY position LIMIT 1",
              )
              .get(user.id) as { key: string } | undefined
          )?.key,
        );
      }
    }
  } else if (first && typeof first === "object") {
    const input = first as {
      orderId?: unknown;
      quoteId?: unknown;
      requestId?: unknown;
    };
    if (["submitReview", "createConversation"].includes(command.method))
      add(input.orderId);
    if (["createOrder", "retireCheckout"].includes(command.method) && user) {
      if (typeof input.requestId === "string") {
        const binding = sql
          .prepare(
            "SELECT order_id FROM biz_order_requests WHERE key=? AND user_id=?",
          )
          .get(JSON.stringify([user.id, input.requestId]), user.id) as
          { order_id: string | null } | undefined;
        add(binding?.order_id);
      }
      if (typeof input.quoteId === "string") {
        const quote = sql
          .prepare(
            "SELECT order_id FROM biz_checkout_quotes WHERE key=? AND user_id=?",
          )
          .get(input.quoteId, user.id) as
          { order_id: string | null } | undefined;
        add(quote?.order_id);
      }
    }
  }
  const domains: NonNullable<DatabaseReadScope["domains"]> = {};
  if (command.method === "confirmSupportProposal")
    domains.conversations = {
      keys: proposalConversation ? [proposalConversation] : [],
      userId: user?.id,
    };
  if (command.method === "createConversation")
    domains.conversations = { appendOnly: "prepend" };
  else if (
    [
      "sendMessage",
      "transferConversation",
      "replyConversation",
      "closeConversation",
    ].includes(command.method)
  )
    domains.conversations = {
      keys: typeof first === "string" ? [first] : [],
      ...(user ? { userId: user.id } : {}),
    };
  if (user) {
    for (const name of ["carts", "addresses", "notifications"] as const)
      domains[name] = { userId: user.id };
    domains.favorites = { keys: [user.id] };
    // Successful quotes are durable replay evidence, not a collection to scan on every checkout.
    const input =
      first && typeof first === "object"
        ? (first as { quoteId?: unknown; requestId?: unknown })
        : {};
    domains.checkoutQuotes = {
      userId: user.id,
      keys: typeof input.quoteId === "string" ? [input.quoteId] : [],
    };
    domains.orderRequests = {
      userId: user.id,
      keys:
        typeof input.requestId === "string"
          ? [JSON.stringify([user.id, input.requestId])]
          : [],
    };
  }
  if (
    ["payOrder", "processAfterSale", "confirmOrder"].includes(command.method)
  ) {
    domains.ledger = { appendOnly: "prepend" };
    domains.inventory = { appendOnly: "prepend" };
    domains.pointsEntries = { appendOnly: "append" };
  }
  return { pendingOnly: true, orderIds: [...ids], domains };
}
export async function transact<T>(
  change: (db: Database) => T,
  reset = false,
): Promise<T> {
  const store = context.getStore()!,
    sql = store.sql,
    command = store.command;
  return transaction(sql, () => {
    const actor = store.user ?? store.admin;
    if (command && actor) {
      const prior = sql
        .prepare(
          "SELECT fingerprint,result FROM command_results WHERE actor_id=? AND method=? AND request_id=?",
        )
        .get(actor.id, command.method, command.requestId) as
        { fingerprint: string; result: string } | undefined;
      if (prior) {
        if (prior.fingerprint !== command.fingerprint)
          throw new HttpError(
            409,
            "请求标识已用于其他内容，请核对原操作",
            "IDEMPOTENCY_CONFLICT",
          );
        return JSON.parse(prior.result) as T;
      }
    }
    const scope =
      command && !reset
        ? commandReadScope(sql, command, store.user)
        : undefined;
    const orderIds = scope?.orderIds ?? [];
    const previous = readDatabase(sql, scope);
    const db = reset ? initialDatabase() : previous;
    try {
      if (reset) {
        // Business reset never deletes registered accounts or their valid sessions.
        db.users = previous.users;
        db.revision = previous.revision;
      }
      const result = change(db);
      if (result && typeof (result as { then?: unknown }).then === "function")
        throw new Error("数据库事务中禁止异步操作");
      db.revision++;
      writeDatabase(sql, db);
      if (command && actor) {
        sql
          .prepare("INSERT INTO command_results VALUES (?,?,?,?,?,?)")
          .run(
            actor.id,
            command.method,
            command.requestId,
            command.fingerprint,
            JSON.stringify(result ?? null),
            now(),
          );
        if (store.admin)
          audit(
            sql,
            actor.id,
            command.method,
            command.requestId,
            "completed",
            (result as { id?: string; movementId?: string } | undefined)?.id ??
              (result as { movementId?: string } | undefined)?.movementId ??
              (typeof command.args[0] === "string"
                ? command.args[0]
                : (command.args[0] as { id?: string } | undefined)?.id) ??
              "global",
          );
        let recipient = store.user?.id,
          orderId: string | undefined;
        const orderMethods = [
          "createOrder",
          "payOrder",
          "cancelOrder",
          "confirmOrder",
          "shipOrder",
          "requestAfterSale",
          "processAfterSale",
          "submitReturn",
        ];
        if (orderMethods.includes(command.method)) {
          orderId =
            command.method === "createOrder" ? String(result) : orderIds[0];
          const order = db.orders.find((o) => o.id === orderId);
          if (order) {
            recipient = order.userId;
            orderId = order.id;
          }
          if (recipient)
            enqueue(
              sql,
              "notification",
              {
                userId: recipient,
                orderId,
                text: (
                  {
                    createOrder: "订单已创建，库存保留30分钟",
                    payOrder: "订单付款成功",
                    cancelOrder: "订单已取消",
                    confirmOrder: "订单已确认收货",
                    shipOrder: "订单已发货",
                    requestAfterSale: "售后申请已受理",
                    processAfterSale: "售后处理进度已更新",
                    submitReturn: "退货信息已提交",
                  } as Record<string, string>
                )[command.method],
              },
              `notification:${actor.id}:${command.method}:${command.requestId}`,
            );
        }
        if (command.method === "replyConversation") {
          const conversation = db.conversations.find(
            (c) => c.id === command.args[0],
          );
          if (conversation)
            enqueue(
              sql,
              "notification",
              {
                userId: conversation.userId,
                text: "客服已回复，请前往咨询会话查看",
              },
              `notification:${actor.id}:${command.method}:${command.requestId}`,
            );
        }
      }
      return result;
    } finally {
      releaseSnapshot(previous);
    }
  });
}
export function ownedOrder(db: Database, orderId: string): Order {
  const order = db.orders.find(
    (o) => o.id === orderId && o.userId === userId(),
  );
  requireThat(order, "订单不存在或不属于当前用户");
  return order;
}
export function productSku(db: Database, productId: string, skuId: string) {
  const product = db.products.find((p) => p.id === productId);
  const sku = product?.skus.find((s) => s.id === skuId);
  requireThat(product && sku, "商品或规格不存在");
  return { product, sku };
}
export function move(
  db: Database,
  productId: string,
  skuId: string,
  delta: number,
  reason: string,
) {
  const { sku } = productSku(db, productId, skuId);
  requireThat(integer(sku.stock + delta), "库存不足或库存数量无效");
  sku.stock += delta;
  const movement = {
    id: id("stock-"),
    productId,
    skuId,
    delta,
    reason,
    createdAt: now(),
  };
  db.inventory.unshift(movement);
  return movement;
}
export function ledger(
  db: Database,
  type: "payment" | "refund" | "purchase",
  amount: number,
  reference: string,
  note: string,
): LedgerEntry {
  requireThat(integer(amount), "金额必须是非负整数分");
  const entry = {
    id: id("ledger-"),
    type,
    amount,
    reference,
    note,
    createdAt: now(),
  };
  db.ledger.unshift(entry);
  return entry;
}
