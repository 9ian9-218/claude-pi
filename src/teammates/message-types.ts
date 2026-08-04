/**
 * message-types.ts — 结构化队友消息（对齐 teammates/message_types.py）
 *
 * 15 种结构化类型 + <teammate-message> 包装；10 使用 idle/shutdown/terminated，
 * permission/plan 相关归 11（构造器先行对齐）。
 */
import { TEAMMATE_MESSAGE_TAG } from "./constants.ts";

const STRUCTURED_TYPES = new Set([
  "idle_notification",
  "permission_request",
  "permission_response",
  "plan_approval_request",
  "plan_approval_response",
  "shutdown_request",
  "shutdown_approved",
  "shutdown_rejected",
  "task_assignment",
  "team_permission_update",
  "mode_set_request",
  "sandbox_permission_request",
  "sandbox_permission_response",
  "teammate_terminated",
]);

export function isStructuredProtocolMessage(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && STRUCTURED_TYPES.has(parsed.type);
  } catch {
    return false;
  }
}

export function parseStructured(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && STRUCTURED_TYPES.has(parsed.type)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

export function formatTeammateMessages(messages: Array<Record<string, unknown>>): string {
  const parts: string[] = [];
  for (const m of messages) {
    const text = String(m["text"] ?? "");
    if (isStructuredProtocolMessage(text)) continue;
    const sender = String(m["from"] ?? "unknown");
    const color = m["color"];
    const summary = m["summary"];
    let attrs = `teammate_id="${sender}"`;
    if (color) attrs += ` color="${color}"`;
    if (summary) attrs += ` summary="${summary}"`;
    parts.push(`<${TEAMMATE_MESSAGE_TAG} ${attrs}>\n${text}\n</${TEAMMATE_MESSAGE_TAG}>`);
  }
  return parts.join("\n\n");
}

// ── 构造器 ────────────────────────────────────────────────────────────────

function genId(prefix = "req"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

export function createIdleNotification(
  agentName: string,
  idleReason = "available",
  summary?: string | null,
): Record<string, unknown> {
  return {
    type: "idle_notification",
    agentName,
    idleReason,
    ...(summary !== undefined && summary !== null ? { summary } : {}),
  };
}

export function createShutdownRequest(
  requestId: string,
  fromAgent: string,
  reason?: string | null,
): Record<string, unknown> {
  return {
    type: "shutdown_request",
    requestId,
    from: fromAgent,
    ...(reason ? { reason } : {}),
  };
}

export function createShutdownApproved(requestId: string, fromAgent: string): Record<string, unknown> {
  return {
    type: "shutdown_approved",
    requestId,
    from: fromAgent,
  };
}

export function createShutdownRejected(
  requestId: string,
  fromAgent: string,
  reason: string,
): Record<string, unknown> {
  return {
    type: "shutdown_rejected",
    requestId,
    from: fromAgent,
    reason,
  };
}

export function createTeammateTerminated(
  agentName: string,
  reason?: string | null,
): Record<string, unknown> {
  return {
    type: "teammate_terminated",
    agentName,
    ...(reason ? { reason } : {}),
  };
}

export function createPermissionRequest(options: {
  requestId?: string;
  from: string;
  toolName: string;
  input: Record<string, unknown>;
  reason?: string;
  teamName?: string;
}): Record<string, unknown> {
  return {
    type: "permission_request",
    request_id: options.requestId ?? genId("perm"),
    from: options.from,
    toolName: options.toolName,
    input: options.input,
    reason: options.reason ?? "",
    teamName: options.teamName ?? "",
  };
}

export function createPermissionResponse(options: {
  requestId: string;
  from: string;
  approved: boolean;
  reason?: string;
}): Record<string, unknown> {
  return {
    type: "permission_response",
    request_id: options.requestId,
    from: options.from,
    approved: options.approved,
    reason: options.reason ?? "",
  };
}
