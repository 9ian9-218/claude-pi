/**
 * permission-sync.ts — 跨 Agent 权限同步（对齐 src/permission_sync.py）
 *
 * 邮箱冒泡流：Worker 规则命中 → permission_request → Lead 收件箱 →
 * poller 入队 → 主线程 askUser（15a 接入 TUI；11 默认 deny 可注入）→
 * permission_response → Worker 500ms 轮询 → 继续/中止。
 * Subagent：同步冒泡（同上下文直接询问）。
 */
import { WORKER_PERMISSION_POLL_INTERVAL } from "./teammates/constants.ts";
import { getAgentContext } from "./teammates/context.ts";
import { sendStructuredMessage, readMailbox, markMessageAsReadByIndex } from "./teammates/mailbox.ts";
import { createPermissionRequest as createPermMsg, createPermissionResponse, parseStructured } from "./teammates/message-types.ts";
import { consumePendingPermissionRequests } from "./teammates/poller.ts";
import { getLeaderName } from "./teammates/team-helpers.ts";
import { checkDenyList, checkRules } from "./permission.ts";

export interface SwarmPermissionRequest {
  id: string;
  workerName: string;
  workerId: string;
  teamName: string;
  toolName: string;
  toolUseId: string;
  description: string;
  input: Record<string, unknown>;
  workerColor: string | null;
  status: "pending" | "approved" | "rejected";
  createdAt: number;
}

export interface PermissionResolution {
  decision: "approved" | "rejected";
  resolvedBy: "worker" | "leader";
  feedback?: string | null;
  updatedInput?: Record<string, unknown> | null;
}

export function generateRequestId(): string {
  return `perm-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

export function createPermissionRequest(options: {
  toolName: string;
  toolUseId: string;
  inputData: Record<string, unknown>;
  description: string;
  teamName?: string | null;
  workerName?: string;
  workerId?: string | null;
  workerColor?: string | null;
}): SwarmPermissionRequest {
  const ctx = getAgentContext();
  return {
    id: generateRequestId(),
    workerName: options.workerName ?? ctx.agentName,
    workerId: options.workerId ?? ctx.agentId ?? ctx.agentName,
    teamName: options.teamName ?? ctx.teamName ?? "default",
    toolName: options.toolName,
    toolUseId: options.toolUseId,
    description: options.description,
    input: options.inputData,
    workerColor: options.workerColor ?? ctx.color,
    status: "pending",
    createdAt: Date.now(),
  };
}

// ── 用户确认（15a 接入 TUI 弹窗；11 默认拒绝 + 可注入） ──────────────────

export type AskUserFn = (
  request: SwarmPermissionRequest,
  label: string,
) => PermissionResolution | Promise<PermissionResolution>;

let askUserImpl: AskUserFn = (request, label) => {
  const color = request.workerColor ?? "white";
  console.log(`\n\x1b[33m⚠  Permission request from ${label} (${color})\x1b[0m`);
  console.log(`   Tool: ${request.toolName}`);
  console.log(`   Reason: ${request.description}`);
  console.log(`   Input: ${JSON.stringify(request.input).slice(0, 200)}`);
  // 15a：TUI 弹窗接入；当前非 TTY 场景默认拒绝
  console.log("   [askUser 未接入 TUI（工单 15a）— 默认拒绝]");
  return {
    decision: "rejected",
    resolvedBy: "leader",
    feedback: null, // 外层拼规则原因（对齐独立 lead 路径）
  };
};

/** 测试/15a 注入用户确认实现 */
export function setAskUserImpl(fn: AskUserFn): void {
  askUserImpl = fn;
}

export function resetAskUserImpl(): void {
  askUserImpl = (request, label) => {
    const color = request.workerColor ?? "white";
    console.log(`\n\x1b[33m⚠  Permission request from ${label} (${color})\x1b[0m`);
    console.log(`   Tool: ${request.toolName}`);
    console.log(`   Reason: ${request.description}`);
    console.log(`   Input: ${JSON.stringify(request.input).slice(0, 200)}`);
    console.log("   [askUser 未接入 TUI（工单 15a）— 默认拒绝]");
    return {
      decision: "rejected",
      resolvedBy: "leader",
      feedback: null,
    };
  };
}

// ── 邮箱发送 ──────────────────────────────────────────────────────────────

export async function sendPermissionRequestViaMailbox(request: SwarmPermissionRequest): Promise<boolean> {
  const leader = getLeaderName(request.teamName);
  const payload = createPermMsg({
    requestId: request.id,
    from: request.workerName,
    toolName: request.toolName,
    input: request.input,
    reason: request.description,
    teamName: request.teamName,
  });
  try {
    await sendStructuredMessage({
      fromAgent: request.workerName,
      toAgent: leader,
      payload,
      teamName: request.teamName,
      color: request.workerColor,
    });
    return true;
  } catch (e) {
    console.log(`  \x1b[31m[permission] failed to send request: ${String(e)}\x1b[0m`);
    return false;
  }
}

export async function sendPermissionResponseViaMailbox(options: {
  workerName: string;
  resolution: PermissionResolution;
  requestId: string;
  teamName: string;
}): Promise<boolean> {
  const subtype = options.resolution.decision === "approved" ? "success" : "error";
  const payload = createPermissionResponse({
    requestId: options.requestId,
    from: getLeaderName(options.teamName),
    approved: options.resolution.decision === "approved",
    reason: options.resolution.feedback ?? "",
  });
  // 对齐 Python：响应 payload 含 subtype/error 字段
  payload["subtype"] = subtype;
  payload["error"] = options.resolution.feedback ?? "";
  try {
    await sendStructuredMessage({
      fromAgent: getLeaderName(options.teamName),
      toAgent: options.workerName,
      payload,
      teamName: options.teamName,
    });
    return true;
  } catch (e) {
    console.log(`  \x1b[31m[permission] failed to send response: ${String(e)}\x1b[0m`);
    return false;
  }
}

// ── Lead 侧处理（主线程） ────────────────────────────────────────────────

export async function processPendingLeadPermissions(teamName: string): Promise<void> {
  for (const item of consumePendingPermissionRequests()) {
    await resolvePermissionItem(item, teamName);
  }
}

async function resolvePermissionItem(
  item: { entry: Record<string, unknown>; parsed: Record<string, unknown>; index: number },
  teamName: string,
): Promise<void> {
  const parsed = item.parsed;
  const request: SwarmPermissionRequest = {
    id: String(parsed["request_id"] ?? generateRequestId()),
    workerName: String(parsed["agent_id"] ?? item.entry["from"] ?? "unknown"),
    workerId: String(parsed["agent_id"] ?? ""),
    teamName,
    toolName: String(parsed["tool_name"] ?? ""),
    toolUseId: String(parsed["tool_use_id"] ?? ""),
    description: String(parsed["description"] ?? "Permission required"),
    input: (parsed["input"] as Record<string, unknown>) ?? {},
    workerColor: (item.entry["color"] as string | null) ?? null,
    status: "pending",
    createdAt: Date.now(),
  };

  const resolution = await askUserImpl(request, `Teammate [${request.workerName}]`);
  await sendPermissionResponseViaMailbox({
    workerName: request.workerName,
    resolution,
    requestId: request.id,
    teamName,
  });
  const leadName = getLeaderName(teamName);
  await markMessageAsReadByIndex(leadName, teamName, item.index);
}

// ── Worker 侧轮询 ────────────────────────────────────────────────────────

export async function pollForPermissionResponse(options: {
  requestId: string;
  agentName: string;
  teamName: string;
  timeoutMs?: number;
}): Promise<PermissionResolution | null> {
  const { requestId, agentName, teamName } = options;
  const timeoutMs = options.timeoutMs ?? 300_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const mailbox = readMailbox(agentName, teamName);
    for (let i = 0; i < mailbox.length; i++) {
      const entry = mailbox[i];
      if (entry.read) continue;
      const parsed = parseStructured(String(entry["text"] ?? ""));
      if (!parsed || parsed["type"] !== "permission_response") continue;
      if (parsed["request_id"] !== requestId) continue;
      await markMessageAsReadByIndex(agentName, teamName, i);
      if (parsed["subtype"] === "success") {
        return { decision: "approved", resolvedBy: "leader" };
      }
      return {
        decision: "rejected",
        resolvedBy: "leader",
        feedback: String(parsed["error"] ?? "Permission denied"),
      };
    }
    await new Promise((r) => setTimeout(r, WORKER_PERMISSION_POLL_INTERVAL * 1000));
  }
  return null;
}

// ── 统一冒泡入口 ──────────────────────────────────────────────────────────

async function bubbleTeammatePermission(options: {
  toolName: string;
  args: Record<string, unknown>;
  reason: string;
  toolUseId: string;
}): Promise<string | null> {
  const ctx = getAgentContext();
  if (!ctx.teamName) {
    return "Permission denied: teammate has no team context";
  }
  const request = createPermissionRequest({
    toolName: options.toolName,
    toolUseId: options.toolUseId,
    inputData: options.args,
    description: options.reason,
  });
  const sent = await sendPermissionRequestViaMailbox(request);
  if (!sent) {
    return "Permission denied: failed to send permission request to lead";
  }
  console.log(`  \x1b[33m[permission] ${ctx.agentName} waiting for lead approval...\x1b[0m`);
  const resolution = await pollForPermissionResponse({
    requestId: request.id,
    agentName: ctx.agentName,
    teamName: ctx.teamName,
  });
  if (resolution === null) {
    return "Permission denied: timed out waiting for lead response";
  }
  if (resolution.decision === "approved") return null;
  return `Permission denied: ${resolution.feedback ?? options.reason}`;
}

async function bubbleSubagentPermission(options: {
  toolName: string;
  args: Record<string, unknown>;
  reason: string;
  toolUseId: string;
}): Promise<string | null> {
  const ctx = getAgentContext();
  const request = createPermissionRequest({
    toolName: options.toolName,
    toolUseId: options.toolUseId,
    inputData: options.args,
    description: options.reason,
    workerName: ctx.agentName,
    workerId: ctx.agentId,
  });
  const resolution = await askUserImpl(request, `Subagent [${ctx.agentName}]`);
  if (resolution.decision === "approved") return null;
  return `Permission denied: ${resolution.feedback ?? options.reason}`;
}

/** 统一权限检查（返回 null 放行，字符串拒绝） */
export async function checkPermissionWithBubble(options: {
  toolName: string;
  args: Record<string, unknown>;
  reason: string;
  toolUseId?: string;
}): Promise<string | null> {
  const ctx = getAgentContext();
  const toolUseId = options.toolUseId || generateRequestId();

  if (ctx.role === "subagent") {
    return bubbleSubagentPermission({
      toolName: options.toolName,
      args: options.args,
      reason: options.reason,
      toolUseId,
    });
  }
  if (ctx.role === "teammate") {
    return bubbleTeammatePermission({
      toolName: options.toolName,
      args: options.args,
      reason: options.reason,
      toolUseId,
    });
  }

  // Lead：本地询问
  const request = createPermissionRequest({
    toolName: options.toolName,
    toolUseId,
    inputData: options.args,
    description: options.reason,
  });
  const resolution = await askUserImpl(request, "Lead");
  if (resolution.decision === "approved") return null;
  return `Permission denied: ${resolution.feedback ?? options.reason}`;
}

/** PreToolUse hook（替换 02b 的 permissionHook；对齐 permission_hook_with_bubble） */
export async function permissionHookWithBubble(block: {
  name: string;
  input: Record<string, unknown>;
  id?: string;
}): Promise<string | null> {
  const toolName = block.name;
  const args = block.input;
  const toolUseId = block.id ?? generateRequestId();

  // Gate 1: bash 黑名单
  if (toolName === "run_bash") {
    const reason = checkDenyList(String(args["command"] ?? ""));
    if (reason) {
      console.log(`\n\x1b[31m⛔ ${reason}\x1b[0m`);
      return reason;
    }
  }

  // Gate 2: 规则
  const reason = checkRules(toolName, args);
  if (!reason) return null;

  // Gate 3: 按身份冒泡
  return checkPermissionWithBubble({ toolName, args, reason, toolUseId });
}

// permission-sync 对外仅暴露 async 冒泡入口（hook.ts 直接注册 permissionHookWithBubble）
