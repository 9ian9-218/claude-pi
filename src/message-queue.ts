/**
 * message-queue.ts — 通知队列（对齐 src/messageQueueManager.py）
 *
 * 后台任务等异步事件入队，agent_loop 每轮 LLM 调用前消费。
 * 优先级：next > later。recipient 用于 teammate 定向（10 接入 context）。
 */
export type NotificationPriority = "next" | "later";

export interface PendingNotification {
  content: string;
  priority: NotificationPriority;
  recipient?: string;
}

let nextQueue: PendingNotification[] = [];
let laterQueue: PendingNotification[] = [];

export function enqueuePendingNotification(
  content: string,
  priority: NotificationPriority = "later",
  options: { recipient?: string } = {},
): void {
  const item: PendingNotification = { content, priority, recipient: options.recipient };
  if (priority === "next") nextQueue.push(item);
  else laterQueue.push(item);
}

export function enqueueTaskNotification(status: string, summary: string): void {
  const xml =
    `<task_notification>\n` +
    `  <status>${status}</status>\n` +
    `  <summary>${summary}</summary>\n` +
    `</task_notification>`;
  enqueuePendingNotification(xml);
}

export function consumePendingNotifications(options: { recipient?: string } = {}): string[] {
  const { recipient } = options;
  const matches = (item: PendingNotification): boolean => {
    if (recipient === undefined) return item.recipient === undefined;
    return item.recipient === recipient;
  };
  const nextItems = nextQueue.filter(matches);
  const laterItems = laterQueue.filter(matches);
  nextQueue = nextQueue.filter((i) => !matches(i));
  laterQueue = laterQueue.filter((i) => !matches(i));
  return [...nextItems, ...laterItems].map((i) => i.content);
}

export function hasPendingNotifications(): boolean {
  return nextQueue.length > 0 || laterQueue.length > 0;
}

/** 测试隔离 */
export function clearNotifications(): void {
  nextQueue = [];
  laterQueue = [];
}
