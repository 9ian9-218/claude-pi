/**
 * prompt.ts — 系统提示组装与缓存（对齐 src/prompt.py）
 *
 * 主 agent system = identity + task_planning + background_tasks + teams + mcp
 *                  + skill_catalog（07 接入）+ memory 段（05 接入）
 * 子 agent system = subagent_identity + skill_catalog
 */

// ── 静态片段 ──────────────────────────────────────────────────────────────

import { PROJECT_ROOT, resolveAgentDirs } from "./config.ts";

const TASKS_DIR = resolveAgentDirs(PROJECT_ROOT).tasksDir;
const MEMORY_DIR = resolveAgentDirs(PROJECT_ROOT).memoryDir;

export const AGENT_IDENTITY =
  "You are a coding agent at {workspace}. " +
  "Use subagent_task for deep research, large subtasks, or multiple " +
  "independent work items that can run concurrently. " +
  "For the current turn's short checklist, use todo_write.";

export const TASK_PLANNING_SECTION =
  `\n\n## Plan and resolve (persisted tasks in ${TASKS_DIR})\n` +
  "When the user gives a large or multi-step goal (feature, refactor, migration, " +
  "several files, or work that may span many tool rounds), use the persisted task " +
  "system — do NOT jump straight into bash/read/write for the whole goal.\n\n" +
  "**Phase 1 — Plan (before implementation tools):**\n" +
  "1. Break the goal into ordered steps with clear subjects.\n" +
  "2. Call create_task for each step; use blockedBy for dependencies " +
  "(e.g. tests blockedBy API task id).\n" +
  "3. Call list_tasks with status_filter='all' to confirm the plan.\n" +
  "4. Optionally use todo_write for the *current* step's micro-actions only.\n\n" +
  "**Phase 2 — Resolve (one persisted task at a time):**\n" +
  "1. claim_task on the next pending task whose dependencies are satisfied.\n" +
  "2. Do the work with read_file, write_file, run_bash, etc.\n" +
  "3. complete_task when that step is done; check which tasks were unblocked.\n" +
  "4. Repeat until all tasks are completed or the user stops you.\n\n" +
  "Rules:\n" +
  "- Do not claim multiple persisted tasks in parallel.\n" +
  "- Use subagent_task for deep dives, large self-contained subtasks,\n" +
  "  or multiple independent work items that can run concurrently.\n" +
  "- Do not complete_task without having claimed it first.\n" +
  "- Add new create_task entries only if the plan truly changes; prefer finishing " +
  "the existing plan first.\n" +
  "- Simple one-shot requests (read one file, run one command) do not need create_task.\n";

export const BACKGROUND_TASKS_SECTION =
  "\n\n## Background tasks (run_bash)\n" +
  "Slow shell commands may run in a background thread when run_in_background is true " +
  "or when the command looks long-running (install, build, test, etc.).\n" +
  "- Set run_in_background=false to force synchronous execution and get output in the " +
  "tool result immediately.\n" +
  "- While a background task runs, you get a placeholder tool result; the real output " +
  "is delivered later as a user message wrapped in <task_notification> XML.\n" +
  "- On completion: <status>completed</status> plus an Output section — read it and " +
  "continue the task.\n" +
  "- On stall (interactive prompt): a statusless notification with last output — " +
  "use kill_bg_task to terminate it, then re-run with non-interactive flags or piped input.\n" +
  "- On prolonged stall (no output for 15s, running for 300s+): a statusless notification — " +
  "use kill_bg_task if the command is stuck.\n";

export const TEAMS_SECTION =
  "\n\n## Agent teams (Lead + Teammates)\n" +
  "Use teammates for large projects needing multiple skill areas, " +
  "many parallel tasks, or work that benefits from role-specific focus.\n\n" +
  "**When to use:** large project generation, multi-aspect implementation " +
  "(frontend + backend + infra), or when you have more tasks than a single " +
  "thread can handle efficiently.\n\n" +
  "**Priority: subagent first.** If a subtask is self-contained and a " +
  "subagent can handle it efficiently, use subagent_task. Only escalate to " +
  "spawn_teammate when the scope is large enough that a dedicated long-running " +
  "agent with role-specific context is genuinely faster.\n\n" +
  "A default team is already initialized at startup — do NOT call create_team " +
  "unless the user explicitly asks for a separate team name.\n" +
  "- Delegate parallel work with spawn_teammate(name, role, prompt, team_name=\"\", ...).\n" +
  "- Pass team_name as empty string to use the current team.\n" +
  "- After spawning: tell the user the teammate is working; do NOT implement the " +
  "teammate's task yourself (no write_file/edit_file for work you delegated).\n" +
  "- Teammate results arrive as <teammate-message> inbox injections — " +
  "summarize them for the user.\n" +
  "- Idle teammates auto-claim unowned pending tasks from the board.\n" +
  "- Use send_message for follow-up; shutdown_teammate for graceful shutdown.\n" +
  "- Plan approval: teammate sends message_type=plan_approval; you review_plan.\n" +
  "- Use list_teammates to check running/offline status.\n";

export const MCP_SECTION =
  "\n\n## MCP tools\n" +
  "Portable tools (read_file, run_bash, tasks, etc.) are exposed via the " +
  "built-in local MCP server as mcp__local__{tool}.\n" +
  "Use connect_mcp to attach external MCP servers (stdio); their tools appear " +
  "as mcp__{server}__{tool}. Use list_mcp_servers to inspect connections.";

export const SUBAGENT_IDENTITY =
  "You are a coding agent at {workspace}. " +
  "Complete the task you were given, then return a concise summary. " +
  "Do not delegate further.";

// ── Memory 段（05 接入数据源，模板先行） ──────────────────────────────────

export const MEMORY_SECTION_EMPTY =
  `\n\nNo memories stored yet.\nMemory directory: ${MEMORY_DIR}\n` +
  "Relevant memories may be injected into the user message when applicable.\n" +
  "When the user says 'remember' or expresses a clear preference, extract it as a memory.";

export const MEMORY_SECTION_WITH_INDEX =
  `\n\nMemories available:\n{index}\nMemory directory: ${MEMORY_DIR}\n` +
  "Relevant memories are injected into the latest user message when applicable.\n" +
  "Respect user preferences from memory.\n" +
  "When the user says 'remember' or expresses a clear preference, extract it as a memory.";

export function buildMemorySection(memoryIndex: string): string {
  if (!memoryIndex.trim()) return MEMORY_SECTION_EMPTY;
  return MEMORY_SECTION_WITH_INDEX.replace("{index}", memoryIndex);
}

// ── 组装与缓存 ────────────────────────────────────────────────────────────

export interface PromptContext {
  skill_catalog?: string;
  workspace?: string;
  memories?: string;
  enabled_tools?: string[];
  mcp_servers?: string[];
  mcp_tool_count?: number;
}

export function assembleSystemPrompt(
  context: PromptContext,
  { isSubagent }: { isSubagent: boolean },
): string {
  const workspace = context.workspace ?? process.cwd();
  const identityTemplate = isSubagent ? SUBAGENT_IDENTITY : AGENT_IDENTITY;
  const identity = identityTemplate.replace("{workspace}", workspace);
  const parts = [identity];
  if (!isSubagent) {
    parts.push(TASK_PLANNING_SECTION, BACKGROUND_TASKS_SECTION, TEAMS_SECTION, MCP_SECTION);
    const servers = context.mcp_servers ?? [];
    if (servers.length > 0) {
      const count = context.mcp_tool_count ?? 0;
      parts.push(`Connected MCP servers: ${servers.join(", ")} (${count} tools discovered).`);
    }
  }
  const skillCatalog = context.skill_catalog ?? "";
  if (skillCatalog) {
    parts.push(skillCatalog);
  }
  if (!isSubagent) {
    parts.push(buildMemorySection(context.memories ?? ""));
  }
  if (parts.length === 1) return parts[0];
  return parts[0] + parts.slice(1).join("");
}

let _lastContextKey: string | null = null;
let _lastPrompt: string | null = null;
let _lastSubagentContextKey: string | null = null;
let _lastSubagentPrompt: string | null = null;

function contextCacheKey(context: PromptContext, isSubagent: boolean): string {
  return JSON.stringify({ ...context, _isSubagent: isSubagent }, Object.keys(context).sort());
}

export function getSystemPrompt(
  context: PromptContext,
  { isSubagent }: { isSubagent: boolean },
): string {
  const key = contextCacheKey(context, isSubagent);
  if (isSubagent) {
    if (key === _lastSubagentContextKey && _lastSubagentPrompt !== null) {
      console.log("  \x1b[90m[cache hit] subagent system prompt unchanged\x1b[0m");
      return _lastSubagentPrompt;
    }
    _lastSubagentContextKey = key;
    _lastSubagentPrompt = assembleSystemPrompt(context, { isSubagent: true });
    console.log("  \x1b[32m[assembled] subagent sections: subagent_identity, skills\x1b[0m");
    return _lastSubagentPrompt;
  }
  if (key === _lastContextKey && _lastPrompt !== null) {
    console.log("  \x1b[90m[cache hit] system prompt unchanged\x1b[0m");
    return _lastPrompt;
  }
  _lastContextKey = key;
  _lastPrompt = assembleSystemPrompt(context, { isSubagent: false });
  const loaded = ["identity", "task_planning", "skills"];
  loaded.push(context.memories ? "memory" : "memory_empty");
  console.log(`  \x1b[32m[assembled] sections: ${loaded.join(", ")}\x1b[0m`);
  return _lastPrompt;
}

/**
 * 收集当前环境状态供 getSystemPrompt 使用。
 * 02a：workspace + 空占位；skill（07）、memory（05）、mcp（19）逐步接入。
 */
export function updateContext(_context: PromptContext, _messages: unknown[]): PromptContext {
  return {
    skill_catalog: "",
    workspace: process.cwd(),
    memories: "",
    enabled_tools: [],
    mcp_servers: [],
    mcp_tool_count: 0,
  };
}
