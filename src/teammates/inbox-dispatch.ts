/**
 * inbox-dispatch.ts — Teammate 收件箱分发（对齐 teammates/inbox_dispatch.py）
 *
 * 读队友邮箱 → 注入 messages；shutdown_request 走 lifecycle 应答。
 * dispatch 返回 { shouldShutdown, injected }。
 */
import { TEAMMATE_IDENTITY_REINJECT_THRESHOLD } from "./constants.ts";
import { readMailbox, markMessagesAsRead, type MailboxMessage } from "./mailbox.ts";
import { formatTeammateMessages, isStructuredProtocolMessage, parseStructured } from "./message-types.ts";
import { handleShutdownRequest } from "./lifecycle.ts";
import type { ChatMessage } from "../client.ts";

export interface DispatchResult {
  shouldShutdown: boolean;
  injected: number;
}

export async function dispatchInboxBatch(options: {
  agentName: string;
  teamName: string;
  messages: ChatMessage[];
}): Promise<DispatchResult> {
  const { agentName, teamName, messages } = options;
  const mailbox = readMailbox(agentName, teamName);
  const plain: MailboxMessage[] = [];
  let shouldShutdown = false;

  for (const entry of mailbox) {
    if (entry.read) continue;
    const text = String(entry["text"] ?? "");
    if (isStructuredProtocolMessage(text)) {
      const parsed = parseStructured(text);
      if (parsed && parsed["type"] === "shutdown_request") {
        await handleShutdownRequest(text, agentName, teamName);
        shouldShutdown = true;
      }
      // 其它结构化消息（permission_response 等）归 11
    } else {
      plain.push(entry);
    }
  }

  if (plain.length > 0) {
    const formatted = formatTeammateMessages(plain as Array<Record<string, unknown>>);
    if (formatted) {
      messages.push({ role: "user", content: formatted });
    }
    await markMessagesAsRead(agentName, teamName);
  }

  return { shouldShutdown, injected: plain.length };
}

/** 身份再注入（对齐 maybe_reinject_identity；11 的 autonomous 也使用） */
export function maybeReinjectIdentity(
  messages: ChatMessage[],
  options: { name: string; role: string; teamName: string; threshold?: number },
): void {
  const threshold = options.threshold ?? TEAMMATE_IDENTITY_REINJECT_THRESHOLD;
  const identity = `You are teammate '${options.name}' on team '${options.teamName}', role: ${options.role}. Complete assigned work; report via send_message when done.`;
  let userCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      userCount += 1;
      if (userCount >= threshold) {
        messages.push({ role: "user", content: identity });
        return;
      }
    }
  }
}
