/**
 * protocol.ts — 结构化协议状态机（对齐 teammates/protocol.py）
 *
 * request_id 关联请求/响应；shutdown / plan_approval 两类协议。
 */
export type ProtocolKind = "shutdown" | "plan_approval";
export type ProtocolStatus = "pending" | "approved" | "rejected";

export interface ProtocolState {
  requestId: string;
  type: ProtocolKind;
  sender: string;
  target: string;
  payload: string;
  status: ProtocolStatus;
  createdAt: number;
}

const pendingRequests = new Map<string, ProtocolState>();

export function newRequestId(prefix = "req"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

export function registerRequest(state: ProtocolState): void {
  pendingRequests.set(state.requestId, state);
}

export function getRequest(requestId: string): ProtocolState | null {
  return pendingRequests.get(requestId) ?? null;
}

/** 通过 request_id 关联响应（对齐 match_response） */
export function matchResponse(options: {
  responseType: string;
  requestId: string;
  approved: boolean;
}): ProtocolState | null {
  if (!options.requestId) return null;
  const state = pendingRequests.get(options.requestId);
  if (!state) return null;
  const expected = {
    shutdown: new Set(["shutdown_approved", "shutdown_rejected"]),
    plan_approval: new Set(["plan_approval_response"]),
  }[state.type];
  if (expected && !expected.has(options.responseType)) return null;
  state.status = options.approved ? "approved" : "rejected";
  return state;
}

export function formatPlanApprovalInjection(parsed: Record<string, unknown>): string {
  const reqId = String(parsed["requestId"] ?? parsed["request_id"] ?? "");
  const fromAgent = String(parsed["from"] ?? "unknown");
  const plan = String(parsed["planContent"] ?? parsed["plan"] ?? "");
  const path_ = String(parsed["planFilePath"] ?? "");
  const lines = [
    "[Plan approval request]",
    `From: ${fromAgent}`,
    `request_id: ${reqId}`,
  ];
  if (path_) lines.push(`Plan file: ${path_}`);
  lines.push(`Plan:\n${plan}`);
  lines.push("Use review_plan(request_id, approve, feedback) to respond.");
  return lines.join("\n");
}

export function formatIdleNotificationInjection(parsed: Record<string, unknown>): string {
  const fromAgent = String(parsed["from"] ?? "unknown");
  const reason = String(parsed["idleReason"] ?? parsed["idle_reason"] ?? "available");
  const summary = String(parsed["summary"] ?? "");
  let text = `[Teammate idle] ${fromAgent} is ${reason}.`;
  if (summary) text += ` Summary: ${summary}`;
  return text;
}

/** 测试隔离 */
export function clearProtocolRequests(): void {
  pendingRequests.clear();
}
