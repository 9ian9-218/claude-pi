/**
 * poller.ts — Lead 收件箱轮询（对齐 teammates/poller.py）
 *
 * 每 1s 轮询 Lead 邮箱：结构化消息路由（10：idle_notification；
 * permission/plan 归 11），普通消息包装为 <teammate-message> 注入队列。
 */
import { LEAD_INBOX_POLL_INTERVAL } from "./constants.ts";
import { readMailbox, acknowledgeMessages, markMessageAsReadByIndex, type MailboxMessage } from "./mailbox.ts";
import { formatTeammateMessages, isStructuredProtocolMessage, parseStructured } from "./message-types.ts";
import { getLeaderName } from "./team-helpers.ts";

// 注入队列（agent_loop 每轮消费）
let pendingInjections: string[] = [];
let pendingDeliveries: Array<{ content: string; entries: MailboxMessage[]; ids: string[]; team: string; lead: string }> = [];
const inFlightDeliveryIds = new Set<string>();
let pendingIdleNotifications: Record<string, unknown>[] = [];
let pendingPermissionRequests: Array<{
  entry: Record<string, unknown>;
  parsed: Record<string, unknown>;
  index: number;
}> = [];

export function consumePendingInjections(): string[] {
  const items = [...pendingInjections];
  pendingInjections = [];
  return items;
}

export function consumePendingIdleNotifications(): Record<string, unknown>[] {
  const items = [...pendingIdleNotifications];
  pendingIdleNotifications = [];
  return items;
}

/** 测试隔离 */
export function clearPollerQueues(): void {
  pendingInjections = [];
  pendingDeliveries = [];
  inFlightDeliveryIds.clear();
  pendingIdleNotifications = [];
  pendingPermissionRequests = [];
}

export function consumePendingPermissionRequests(): Array<{
  entry: Record<string, unknown>;
  parsed: Record<string, unknown>;
  index: number;
}> {
  const items = [...pendingPermissionRequests];
  pendingPermissionRequests = [];
  return items;
}

async function routeMessage(entry: MailboxMessage, index: number, teamName: string, leadName: string): Promise<void> {
  const text = String(entry["text"] ?? "");
  if (!isStructuredProtocolMessage(text)) return;
  const parsed = parseStructured(text);
  if (!parsed) return;

  const msgType = parsed["type"];
  if (msgType === "idle_notification") {
    pendingIdleNotifications.push(parsed);
    await markMessageAsReadByIndex(leadName, teamName, index);
    return;
  }
  if (msgType === "permission_request" || msgType === "sandbox_permission_request") {
    // 去重后入队（主线程 processPendingLeadPermissions 消费）
    const reqId = String(parsed["request_id"] ?? parsed["requestId"] ?? "");
    if (!pendingPermissionRequests.some((i) => String(i.parsed["request_id"] ?? i.parsed["requestId"] ?? "") === reqId)) {
      pendingPermissionRequests.push({ entry: entry as Record<string, unknown>, parsed, index });
    }
    return;
  }
  if (msgType === "plan_approval_request") {
    const { formatPlanApprovalInjection, registerRequest } = await import("./protocol.ts");
    const reqId = String(parsed["requestId"] ?? parsed["request_id"] ?? "");
    const fromAgent = String(entry["from"] ?? parsed["from"] ?? "unknown");
    registerRequest({
      requestId: reqId,
      type: "plan_approval",
      sender: fromAgent,
      target: leadName,
      payload: String(parsed["planContent"] ?? ""),
      status: "pending",
      createdAt: Date.now(),
    });
    pendingInjections.push(formatPlanApprovalInjection(parsed));
    await markMessageAsReadByIndex(leadName, teamName, index);
    return;
  }
  await markMessageAsReadByIndex(leadName, teamName, index);
}

let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollTeamName: string | null = null;

export async function startLeadInboxPoller(teamName: string): Promise<void> {
  pollTeamName = teamName;
  if (pollTimer) return;
  console.log(`  \x1b[36m[poller] lead inbox poller started (team=${teamName})\x1b[0m`);
  pollTimer = setInterval(() => {
    void pollOnce(teamName);
  }, LEAD_INBOX_POLL_INTERVAL * 1000);
  // unref：不阻止进程退出（对齐 Python daemon 线程语义）
  pollTimer.unref();
}

export function getPolledTeam(): string | null {
  return pollTeamName;
}

export function stopLeadInboxPoller(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/** 单次轮询（测试可直接调用） */
export async function pollOnce(teamName: string): Promise<void> {
  if (!pollTeamName && !teamName) return;
  try {
    const leadName = getLeaderName(teamName);
    const mailbox = readMailbox(leadName, teamName);
    const plainBatch: MailboxMessage[] = [];
    const queued = new Set([...pendingDeliveries.flatMap(d => d.ids), ...inFlightDeliveryIds]);

    for (let i = 0; i < mailbox.length; i++) {
      const entry = mailbox[i];
      if (entry.read) continue;
      const text = String(entry["text"] ?? "");
      if (isStructuredProtocolMessage(text)) {
        await routeMessage(entry, i, teamName, leadName);
      } else {
        if (!queued.has(entry.id!)) plainBatch.push(entry);
      }
    }

    if (plainBatch.length > 0) {
      const formatted = formatTeammateMessages(plainBatch as Array<Record<string, unknown>>);
      const ids = plainBatch.map(message => message.id!);
      if (formatted && !pendingDeliveries.some(d => d.team === teamName && d.ids.join(",") === ids.join(","))) {
        pendingDeliveries.push({ content: formatted, entries: plainBatch, ids, team: teamName, lead: leadName });
      }
    }
  } catch (e) {
    console.log(`  \x1b[31m[poller] error: ${String(e)}\x1b[0m`);
  }
}

/** Persist a delivery in the session before ACK. Replayed IDs never cause a second injection. */
export async function deliverPendingMessages(session: import("../session-manager.ts").SessionManager | undefined, messages: import("../client.ts").ChatMessage[]): Promise<void> {
  const deliveries = pendingDeliveries;
  for (const delivery of deliveries) for (const id of delivery.ids) inFlightDeliveryIds.add(id);
  pendingDeliveries = [];
  try {
    for (const delivery of deliveries) {
      const known = new Set(session?.getEntries().flatMap(e => e.type === "message" && e.message.mailboxDelivery?.team === delivery.team ? e.message.mailboxDelivery.ids : []) ?? []);
      const entries = delivery.entries.filter(e => !known.has(e.id!));
      if (entries.length) {
        const ids = entries.map(e => e.id!);
        const content = formatTeammateMessages(entries as Array<Record<string, unknown>>);
        const message: import("../client.ts").ChatMessage = { role: "user", content, mailboxDelivery: { team: delivery.team, ids } };
        session?.appendMessage(message); messages.push(message);
      }
      await acknowledgeMessages(delivery.lead, delivery.team, delivery.ids);
    }
  } finally { for (const delivery of deliveries) for (const id of delivery.ids) inFlightDeliveryIds.delete(id); }
}
