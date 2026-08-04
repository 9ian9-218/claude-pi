/**
 * inbox-dispatch.ts — Teammate 收件箱分发（对齐 teammates/inbox_dispatch.py）
 *
 * 读队友邮箱 → 注入 messages；shutdown_request 走 lifecycle 应答。
 * 有新消息时 resumeWork=true（autonomous idle 据此回到 WORK）。
 */
import { readMailbox, markMessagesAsRead, type MailboxMessage } from "./mailbox.ts";
import { formatTeammateMessages, isStructuredProtocolMessage, parseStructured } from "./message-types.ts";
import { handleShutdownRequest } from "./lifecycle.ts";
import { maybeReinjectIdentity as reinject } from "./autonomous.ts";
import type { ChatMessage } from "../client.ts";

export interface DispatchResult {
  shouldShutdown: boolean;
  resumeWork: boolean;
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
      // permission_response 由 pollForPermissionResponse 自读自标；
      // 其它结构化消息忽略（已读标记由 poller/协议处理）
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

  return { shouldShutdown, resumeWork: plain.length > 0, injected: plain.length };
}

// 统一入口：身份再注入（对齐 teammates/autonomous.py maybe_reinject_identity）
export function maybeReinjectIdentity(
  messages: ChatMessage[],
  options: { name: string; role: string; teamName: string },
): void {
  reinject(messages, options);
}
