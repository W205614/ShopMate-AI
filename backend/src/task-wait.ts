import {
  defaultTaskWaitMinutes,
  type TaskWaitKey,
} from "../../shared/domain/operations";
import type { Settings } from "../../shared/domain/types";

export const taskQueues = {
  orders: {
    status: "paid",
    table: "biz_orders",
    since: "json_extract(data,'$.paidAt')",
    permission: "warehouse",
    minutesKey: "shipWaitMinutes",
  },
  afterSales: {
    status: "requested",
    table: "biz_after_sales",
    since: "created_at",
    permission: "support",
    minutesKey: "reviewWaitMinutes",
  },
  conversations: {
    status: "waiting",
    table: "biz_conversations",
    since: "json_extract(data,'$.waitingSince')",
    permission: "support",
    minutesKey: "supportWaitMinutes",
  },
} as const;

export function taskWaitWindow(
  key: TaskWaitKey,
  settings?: Settings,
  at = Date.now(),
) {
  const minutes = settings?.[key] ?? defaultTaskWaitMinutes[key];
  const warning = Math.min(60, Math.ceil(minutes / 2));
  return {
    overdue: new Date(at - minutes * 60_000).toISOString(),
    soon: new Date(at - (minutes - warning) * 60_000).toISOString(),
  };
}

export function taskQueue(domain: string, status?: string) {
  const queue = Object.hasOwn(taskQueues, domain)
    ? taskQueues[domain as keyof typeof taskQueues]
    : undefined;
  return queue && queue.status === status ? queue : undefined;
}
