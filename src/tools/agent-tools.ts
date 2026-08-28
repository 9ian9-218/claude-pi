/**
 * agent-tools.ts — subagent_task / 队友工具（从 tool.ts 拆出）
 */
import { randomBytes } from "node:crypto";
import type { ChatMessage } from "../client.ts";
import { SUBAGENT_IDENTITY, SUBAGENT_STOPPED_MESSAGE } from "../prompt.ts";
import {
  getAgentContext,
  createAgentContext,
  runWithAgentContext,
  setAgentContext,
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
import { buildTool } from "./core.ts";
import { getWorkdir } from "../workdir.ts";

// ── subagent（09） ─────────────────────────────────────────────────────────

/** 子 agent 禁用工具（对齐 Python SUBAGENT_EXCLUDED_UNDERLYING） */
export const SUBAGENT_EXCLUDED: Set<string> = new Set([
  "todo_write",
  "subagent_task",
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

/** 子 agent：独立 messages，返回最终文本摘要（对齐 _spawn_subagent） */
export async function spawnSubagent(description: string): Promise<string> {
  const { agentLoop } = await import("../agent-loop.ts");
  const subId = `subagent-${randomBytes(4).toString("hex")}`;
  console.log(`
[35m[Subagent spawned: ${subId}][0m`);
  // 继承父级 team（若 Lead 已入 ALS），role 固定 subagent —— 权限同步冒泡给 Lead
  const parent = getAgentContext();
  const profile = AgentProfile.subagent({
    teamName: parent.teamName,
    agentName: subId,
    agentId: subId,
    agentType: "general-purpose",
  });
  const messages: ChatMessage[] = [
    { role: "system", content: SUBAGENT_IDENTITY.replace("{workspace}", getWorkdir()) },
    { role: "user", content: description },
  ];
  const result = await runWithAgentContext(profileToContext(profile), async () =>
    agentLoop(messages, {
      maxTurn: 30,
      maxTokens: 6000,
      loopOptions: LoopOptions.fromProfile(profile),
    }),
  );
  if (result) {
    console.log("[35m[Subagent done][0m");
    return result;
  }
  return SUBAGENT_STOPPED_MESSAGE;
}

function execSubagentTask(args: Record<string, unknown>): Promise<string> {
  return spawnSubagent(String(args["description"]));
}

const SUBAGENT_TASK_SCHEMA = {
  type: "object",
  properties: {
    description: {
      type: "string",
      description: "What the subagent should accomplish",
    },
  },
  required: ["description"],
  additionalProperties: false,
};

export const SUBAGENT_TASK_TOOL = buildTool({
  name: "subagent_task",
  description:
    "Launch a subagent for deep research, a large self-contained subtask, " +
    "or one of multiple independent work items. " +
    "Subagents return a text summary when done.",
  parameters: SUBAGENT_TASK_SCHEMA,
  execute: execSubagentTask,
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
