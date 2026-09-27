/**
 * agent-tools.ts — subagent_task / 队友工具（从 tool.ts 拆出）
 */
import { randomBytes } from "node:crypto";
import type { ChatMessage } from "../client.ts";
import { SUBAGENT_STOPPED_MESSAGE, getRoleIdentity } from "../prompt.ts";
import {
  getAgentContext,
  createAgentContext,
  runWithAgentContext,
  setAgentContext,
  type AgentRole,
} from "../teammates/context.ts";
import { createTeam, readTeamConfig } from "../teammates/team-helpers.ts";
import { startLeadInboxPoller, stopLeadInboxPoller, getPolledTeam } from "../teammates/poller.ts";
import {
  spawnTeammate,
  requestTeammateShutdown,
  listActiveTeammateNames,
} from "../teammates/spawn.ts";
import { sendPlainMessage } from "../teammates/mailbox.ts";
import { AgentProfile, profileToContext } from "../agent-profile.ts";
import { LoopOptions } from "../loop-options.ts";
import { buildTool, type ToolExecContext } from "./core.ts";
import { SessionManager } from "../session-manager.ts";
import {
  startAgentRun,
  updateAgentRun,
  appendAgentText,
  finishAgentRun,
} from "../agent-registry.ts";
import { UiEventSink } from "../ui-events.ts";
import { computeUsageTotals } from "../usage-stats.ts";
import { describeRoleRestrictions } from "./runtime.ts";
import { getWorkdir } from "../workdir.ts";

// ── subagent（09） ─────────────────────────────────────────────────────────

/** 子 agent 禁用工具（对齐 Python SUBAGENT_EXCLUDED_UNDERLYING） */
export const SUBAGENT_EXCLUDED: Set<string> = new Set([
  "todo_write",
  "subagent_task",
  "delegate",
  "create_task",
  "claim_task",
  "complete_task",
  "spawn_teammate",
  "create_team",
  "send_message",
  "list_teammates",
  "shutdown_teammate",
  "review_plan",
  "connect_mcp",
  "disconnect_mcp",
  "list_mcp_servers",
  "kill_bg_task",
]);

export interface SpawnSubagentOptions {
  role?: AgentRole;
  contextPackage?: string;
  maxTurns?: number;
  /** 父会话：登记血缘，让子会话接进会话树 */
  parentSession?: SessionManager | null;
  /** 父 UI 通道：有 UI 时不再往 stdout 打日志（改由 AgentPanel 展示） */
  parentUiEvents?: UiEventSink;
}

/** 无 UI 时的日志回退（TUI 下由折叠面板承载，避免污染 pi-tui 渲染） */
function logIfNoUi(sink: UiEventSink | undefined, text: string): void {
  if (!sink) console.log(text);
}

/**
 * 子 agent / 专职 Pipeline 角色：独立 messages + 独立子会话 + 注册表可观测。
 * 轨迹落盘到子会话（可 /resume 或 cpi --session <id> 复查），父会话登记血缘。
 */
export async function spawnSubagent(
  description: string,
  options: SpawnSubagentOptions = {},
): Promise<string> {
  const { agentLoop } = await import("../agent-loop.ts");
  const role: AgentRole = options.role ?? "subagent";
  const subId = `${role}-${randomBytes(4).toString("hex")}`;
  const goal = description.trim();
  const parentSession = options.parentSession ?? null;
  const parentFile = parentSession?.getSessionFile() ?? null;
  const workspace = getWorkdir();

  // 子会话落盘：
  //  - 有父会话 → fork 父分支（system / 工具面 / 历史前缀与父一致 → prompt cache 命中）
  //  - 无父会话（测试或直接调用）→ 独立空会话 + 角色 system 提示
  let childSession: SessionManager | null = null;
  let forked = false;
  const sessionName = `${role}: ${goal.slice(0, 60)}`;
  try {
    if (parentSession) {
      childSession = SessionManager.forkChild(parentSession, sessionName);
      forked = true;
    } else {
      childSession = SessionManager.createChild(workspace, null, sessionName);
    }
  } catch (err) {
    childSession = null;
    logIfNoUi(options.parentUiEvents, `  \x1b[31m[${role}] 子会话创建失败：${String(err)}\x1b[0m`);
  }
  const sessionId = childSession?.sessionId;
  const sessionFile = childSession?.getSessionFile() ?? undefined;

  // 父会话登记：/tree 与 /export 可见
  parentSession?.appendCustom("subagent", {
    agentId: subId,
    role,
    goal: goal.slice(0, 200),
    sessionId: sessionId ?? null,
    sessionFile: sessionFile ?? null,
  });

  startAgentRun({
    id: subId,
    role,
    label: `${role} · ${goal.slice(0, 40)}`,
    ...(sessionId ? { sessionId } : {}),
    ...(sessionFile ? { sessionFile } : {}),
    ...(parentFile ? { parentSessionFile: parentFile } : {}),
  });
  logIfNoUi(options.parentUiEvents, `\n\x1b[35m[${role} spawned: ${subId}]\x1b[0m`);

  // 继承父级 team（若 Lead 已入 ALS），设定专职角色 Profile
  const parent = getAgentContext();
  const profile = AgentProfile.fromRole(role, {
    teamName: parent.teamName,
    agentName: subId,
    agentId: subId,
    agentType: role,
  });

  const roleBrief = getRoleIdentity(role, workspace);

  let initialUserPrompt = description;
  if (options.contextPackage && options.contextPackage.trim()) {
    initialUserPrompt = `[Context Package / Upstream Deliverable]:\n${options.contextPackage.trim()}\n\n[Assigned Goal]:\n${description}`;
  }

  // 一次性任务：只做这一件事，做完返回结果即结束（不驻留、不等待再派活）
  let messages: ChatMessage[];
  if (forked && childSession) {
    // fork 模式：沿用父 system 提示 + 父历史，角色契约与任务放进尾部 user 消息，
    // 这样前缀与父请求保持一致，provider 端才能命中 prompt cache。
    const restrictions = describeRoleRestrictions(role);
    const tail =
      `[Role Brief — ${role}]\n${roleBrief}\n\n` +
      `[Restrictions — 仅本任务有效，由运行时强制执行]\n${restrictions}\n\n` +
      `[Assigned Task — 只做这一件事，完成后返回结果即结束]\n${initialUserPrompt}`;
    const history = childSession.buildSessionContext().messages;
    messages = [...history, { role: "user", content: tail }];
    childSession.appendMessage({ role: "user", content: tail });
  } else {
    messages = [
      { role: "system", content: roleBrief },
      { role: "user", content: initialUserPrompt },
    ];
    childSession?.appendMessage({ role: "user", content: initialUserPrompt });
  }

  // 子 agent 的 UI 事件只喂注册表（父面板折叠展示），不进父聊天区
  const agentSink = new UiEventSink();
  let turns = 0;
  let toolCalls = 0;
  agentSink.on("stream", (delta) => {
    if (delta.kind === "text") appendAgentText(subId, delta.delta);
  });
  agentSink.on("tool", (event) => {
    if (event.phase === "start") {
      toolCalls += 1;
      updateAgentRun(subId, { lastTool: event.name, toolCalls });
    }
  });
  // 子会话用量聚合：每个回合结束与收尾时从子会话 entry 现算（token/成本）
  const refreshUsage = () => {
    if (!childSession) return;
    const patch: Parameters<typeof updateAgentRun>[1] = {
      usage: { ...computeUsageTotals(childSession.getEntries()) },
    };
    // 首轮缓存读写：cacheRead > 0 ⇒ 命中了父会话前缀（fork 生效的现场证据）
    const firstAssistant = childSession.getEntries().find((entry) => {
      if (entry.type !== "message") return false;
      const message = entry.message as { role?: string; usage?: { cacheRead?: number; cacheWrite?: number } };
      return message.role === "assistant" && message.usage !== undefined;
    });
    if (firstAssistant && firstAssistant.type === "message") {
      const usage = (firstAssistant.message as { usage?: { cacheRead?: number; cacheWrite?: number } }).usage;
      if (usage) {
        patch.firstTurnCache = {
          cacheRead: usage.cacheRead ?? 0,
          cacheWrite: usage.cacheWrite ?? 0,
        };
      }
    }
    updateAgentRun(subId, patch);
  };
  agentSink.on("turnEnd", () => {
    turns += 1;
    updateAgentRun(subId, { turns });
    refreshUsage();
  });

  const maxTurns = options.maxTurns ?? (role === "scout" || role === "planner" ? 15 : 30);

  // fork 子 agent：system 提示与工具面按父身份构造，缓存路由用父会话 id
  const loopOptions = LoopOptions.fromProfile(profile, {
    uiEvents: agentSink,
    ...(forked && parentSession
      ? {
          cachePrefix: { role: parent.role, isSubagent: parent.role === "subagent" },
          routingSessionId: parentSession.sessionId,
        }
      : {}),
  });

  try {
    const result = await runWithAgentContext(profileToContext(profile), async () =>
      agentLoop(messages, {
        maxTurn: maxTurns,
        maxTokens: 6000,
        ...(childSession ? { session: childSession } : {}),
        loopOptions,
      }),
    );

    if (result) {
      refreshUsage();
      finishAgentRun(subId, { status: "done", result });
      parentSession?.appendCustom("subagent_end", {
        agentId: subId,
        status: "done",
        result: result.slice(0, 500),
      });
      logIfNoUi(options.parentUiEvents, ` \x1b[35m[${role} done] ${subId}\x1b[0m`);
      return result;
    }

    refreshUsage();
    finishAgentRun(subId, { status: "failed", error: SUBAGENT_STOPPED_MESSAGE });
    parentSession?.appendCustom("subagent_end", { agentId: subId, status: "failed" });
    return SUBAGENT_STOPPED_MESSAGE;
  } catch (err) {
    refreshUsage();
    finishAgentRun(subId, { status: "failed", error: String(err) });
    parentSession?.appendCustom("subagent_end", {
      agentId: subId,
      status: "failed",
      error: String(err),
    });
    throw err;
  }
}

function execSubagentTask(args: Record<string, unknown>, ctx?: ToolExecContext): Promise<string> {
  const role = args["role"] ? (String(args["role"]) as AgentRole) : undefined;
  return spawnSubagent(String(args["description"]), {
    role,
    parentSession: ctx?.session ?? null,
    parentUiEvents: ctx?.uiEvents,
  });
}

const SUBAGENT_TASK_SCHEMA = {
  type: "object",
  properties: {
    description: {
      type: "string",
      description: "What the subagent should accomplish",
    },
    role: {
      type: "string",
      enum: ["subagent", "scout", "planner", "worker", "reviewer", "verifier"],
      description: "Optional specialist role in the coding pipeline",
    },
  },
  required: ["description"],
  additionalProperties: false,
};

export const SUBAGENT_TASK_TOOL = buildTool({
  name: "subagent_task",
  description:
    "Launch a ONE-SHOT subagent for deep research, a large self-contained subtask, " +
    "or one of multiple independent work items. " +
    "It forks the current session (shared prefix → prompt cache reuse), handles only the " +
    "task you hand it, returns a text summary, and then ends — it never waits for follow-ups.",
  parameters: SUBAGENT_TASK_SCHEMA,
  execute: execSubagentTask,
  isReadOnly: false,
});

function execDelegateTask(args: Record<string, unknown>, ctx?: ToolExecContext): Promise<string> {
  const role = String(args["role"]) as AgentRole;
  const task = String(args["task"]);
  const context = args["context"] ? String(args["context"]) : undefined;
  return spawnSubagent(task, {
    role,
    contextPackage: context,
    parentSession: ctx?.session ?? null,
    parentUiEvents: ctx?.uiEvents,
  });
}

const DELEGATE_TASK_SCHEMA = {
  type: "object",
  properties: {
    role: {
      type: "string",
      enum: ["scout", "planner", "worker", "reviewer", "verifier"],
      description: "The specialist role to perform this task in the coding pipeline",
    },
    task: {
      type: "string",
      description: "Concrete instructions or requirements for this role",
    },
    context: {
      type: "string",
      description: "Optional upstream context, findings, or previous step deliverables",
    },
  },
  required: ["role", "task"],
  additionalProperties: false,
};

export const DELEGATE_TASK_TOOL = buildTool({
  name: "delegate",
  description:
    "Delegate ONE-SHOT tasks to specialized agent roles in the coding pipeline. " +
    "Each delegation forks the current session (shared prefix → prompt cache reuse), runs once, " +
    "returns its deliverable, and ends:\n" +
    "- scout: fast recon to find code locations and extract relevant context without modifying anything.\n" +
    "- planner: create an implementation plan and test criteria without making changes.\n" +
    "- worker: implement code changes according to a plan and run self-tests.\n" +
    "- reviewer: inspect changes for bugs, style, security, and spec conformance (read-only).\n" +
    "- verifier: run tests, builds, and lint to objectively verify correctness and regressions.",
  parameters: DELEGATE_TASK_SCHEMA,
  execute: execDelegateTask,
  isReadOnly: false,
});

// ── 队友工具（10） ────────────────────────────────────────────────────────

function execCreateTeam(args: Record<string, unknown>): string {
  const name = String(args["name"]);
  if (readTeamConfig(name)) {
    return `Team '${name}' already exists`;
  }
  createTeam(name);
  const ctx = getAgentContext();
  // lead 加入新团队并让收件箱轮询指向它（poller 单例：当前团队即 lead 驻在团队；
  // 旧代码 if(!ctx.teamName) 在 initLeadTeam 之后恒不命中 → 二队队友权限/消息无人消费）
  setAgentContext(
    createAgentContext({
      teamName: name,
      role: ctx.role === "teammate" ? "teammate" : "lead",
      agentName: ctx.agentName,
      agentId: ctx.agentId,
      color: ctx.color,
      agentType: ctx.agentType,
    }),
  );
  if (getPolledTeam() !== name) {
    stopLeadInboxPoller();
    void startLeadInboxPoller(name);
  }
  return `Created team '${name}' with lead inbox`;
}

function execSpawnTeammate(args: Record<string, unknown>): string {
  const ctx = getAgentContext();
  const teamName = String(args["team_name"] ?? "").trim() || ctx.teamName || "";
  const agentType = String(args["agent_type"] ?? "").trim() || "general-purpose";
  if (!teamName) {
    return "Error: no team. Call create_team first or pass team_name.";
  }
  return spawnTeammate({
    name: String(args["name"]),
    role: String(args["role"]),
    prompt: String(args["prompt"]),
    teamName,
    agentType,
  });
}

function execSendMessage(args: Record<string, unknown>): Promise<string> {
  const to = String(args["to"]);
  const message = String(args["message"]);
  const summary = String(args["summary"] ?? "");
  const messageType = String(args["message_type"] ?? "plain");
  const ctx = getAgentContext();
  const teamName = ctx.teamName ?? "";
  if (!teamName) return Promise.resolve("Error: no team context");
  if (messageType !== "plain") {
    // task_assignment / plan_approval 结构消息归 11（protocol）
    return Promise.resolve(`Error: message_type '${messageType}' not supported yet`);
  }
  return sendPlainMessage({
    fromAgent: ctx.agentName,
    toAgent: to,
    text: message,
    teamName,
    color: ctx.color,
    summary: summary || null,
  }).then(() => `Message sent to ${to}`);
}

function execListTeammates(args: Record<string, unknown>): string {
  const teamName = String(args["team_name"] ?? "").trim() || undefined;
  const names = listActiveTeammateNames(teamName);
  return names.length > 0 ? names.join(", ") : "No active teammates";
}

function execShutdownTeammate(args: Record<string, unknown>): Promise<string> {
  const ctx = getAgentContext();
  const teamName = String(args["team_name"] ?? "").trim() || ctx.teamName || "";
  if (!teamName) return Promise.resolve("Error: no team context");
  return requestTeammateShutdown(String(args["name"]), teamName);
}

const CREATE_TEAM_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", description: "Team name (stored under .agent/teams/)" },
  },
  required: ["name"],
  additionalProperties: false,
};

const SPAWN_TEAMMATE_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", description: "Unique teammate name within the team" },
    role: { type: "string", description: "Role description, e.g. researcher" },
    prompt: { type: "string", description: "Initial task instructions" },
    team_name: { type: "string", description: "Team name; use empty string for current team" },
    agent_type: {
      type: "string",
      description: "Agent type; use general-purpose if unsure",
    },
  },
  required: ["name", "role", "prompt", "team_name", "agent_type"],
  additionalProperties: false,
};

const SEND_MESSAGE_SCHEMA = {
  type: "object",
  properties: {
    to: { type: "string", description: "Recipient agent name or team-lead" },
    message: { type: "string", description: "Message body" },
    summary: { type: "string", description: "Short preview for UI" },
    message_type: {
      type: "string",
      enum: ["plain", "task_assignment", "plan_approval"],
      description: "plain for DM; structured types land in 11",
    },
    task_id: { type: "string", description: "Task ID when message_type=task_assignment" },
    subject: { type: "string", description: "Task subject when message_type=task_assignment" },
    plan_file_path: {
      type: "string",
      description: "Optional plan file path when message_type=plan_approval",
    },
  },
  required: ["to", "message", "summary", "message_type", "task_id", "subject", "plan_file_path"],
  additionalProperties: false,
};

const LIST_TEAMMATES_SCHEMA = {
  type: "object",
  properties: {
    team_name: { type: "string", description: "Team name; empty for current team" },
  },
  required: ["team_name"],
  additionalProperties: false,
};

const SHUTDOWN_TEAMMATE_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", description: "Teammate name to shut down" },
    team_name: { type: "string", description: "Team name; empty for current team" },
  },
  required: ["name", "team_name"],
  additionalProperties: false,
};

export const CREATE_TEAM_TOOL = buildTool({
  name: "create_team",
  description:
    "Create a NEW team only when the user explicitly requests a separate team. " +
    "A default team already exists at startup — prefer spawn_teammate with " +
    'team_name="" instead of creating another team.',
  parameters: CREATE_TEAM_SCHEMA,
  execute: execCreateTeam,
  isReadOnly: false,
});

export const SPAWN_TEAMMATE_TOOL = buildTool({
  name: "spawn_teammate",
  description:
    "Spawn a background teammate to execute delegated work. " +
    "Pass team_name as empty string to use the current team. " +
    "After spawning, tell the user the teammate is working — do NOT do the " +
    "delegated work yourself. Results arrive via teammate inbox notifications.",
  parameters: SPAWN_TEAMMATE_SCHEMA,
  execute: execSpawnTeammate,
  isReadOnly: false,
});

export const SEND_MESSAGE_TOOL = buildTool({
  name: "send_message",
  description: "Send a message to another teammate or the team lead via file mailbox.",
  parameters: SEND_MESSAGE_SCHEMA,
  execute: execSendMessage,
  isReadOnly: false,
});

export const LIST_TEAMMATES_TOOL = buildTool({
  name: "list_teammates",
  description: "List active teammates (optionally filtered by team).",
  parameters: LIST_TEAMMATES_SCHEMA,
  execute: execListTeammates,
  isReadOnly: true,
});

export const SHUTDOWN_TEAMMATE_TOOL = buildTool({
  name: "shutdown_teammate",
  description: "Send a graceful shutdown request to a teammate.",
  parameters: SHUTDOWN_TEAMMATE_SCHEMA,
  execute: execShutdownTeammate,
  isReadOnly: false,
});

// ── 注册表与对外 API ──────────────────────────────────────────────────────
