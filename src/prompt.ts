/**
 * prompt.ts — 系统提示组装与缓存（对齐 src/prompt.py）
 *
 * 主 agent system = identity + task_planning + background_tasks + teams + mcp
 *                  + skill_catalog（07 接入）+ memory 段（05 接入）
 * 子 agent system = subagent_identity + skill_catalog
 */

// ── 静态片段 ──────────────────────────────────────────────────────────────

import { AGENT_ROOT, resolveAgentDirs } from "./config.ts";
import { type AgentRole } from "./teammates/context.ts";
import { peekMemorySnapshot } from "./memory-scope.ts";
import { getSkillCatalog } from "./skill-load.ts";
import { getMCPHub } from "./mcp/hub.ts";
import { getTeamMode } from "./settings.ts";

const TASKS_DIR = resolveAgentDirs(AGENT_ROOT).tasksDir;
const MEMORY_DIR = resolveAgentDirs(AGENT_ROOT).memoryDir;

export const AGENT_IDENTITY =
  "You are a coding agent at {workspace}. " +
  "Use subagent_task for deep research, large subtasks, or multiple " +
  "independent work items that can run concurrently. " +
  "Subagents are one-shot forks of this session: they take a single delegated task, " +
  "return a result, and end — use them for bounded work, not for ongoing collaboration. " +
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
  "**Subagents vs teammates:** subagents are one-shot (delegate a task, get the " +
  "result, session ends) and reuse this session's prompt cache; teammates are persistent " +
  "long-lived workers. Use teammates only when you truly need ongoing parallel collaboration.\n\n" +
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

export const PIPELINE_SECTION =
  "\n\n## Coding pipeline (role-delegation preset)\n" +
  "This session runs the coding-pipeline preset: route work through specialist one-shot " +
  "subagents with `delegate(role, task, context?)` instead of doing everything yourself. " +
  "Each delegation forks this session (shared prompt-cache prefix) and returns a deliverable.\n\n" +
  "- `scout`: locate code, trace call paths, extract the minimal context package (read-only).\n" +
  "- `planner`: turn requirements + scouted context into ordered steps and acceptance criteria (read-only).\n" +
  "- `worker`: implement the change and run self-tests (the only role allowed to write files).\n" +
  "- `reviewer`: adversarial static review of the diff for bugs, style and security (read-only).\n" +
  "- `verifier`: run tests / build / type-check and report objective evidence (read-only).\n\n" +
  "**Standard flow: scout → planner → worker → reviewer → verifier.** Skip a stage only when it is " +
  "genuinely unnecessary (trivial edit: scout + worker + verifier). Pass each stage the previous " +
  "stage's deliverable through `context`. Route review findings back to `worker`, then re-verify. " +
  "While delegating, your own job is routing, merging and reporting — do not edit files yourself.\n\n" +
  "**This is enforced by the runtime, not a request:** your own `write_file` / `edit_file` / " +
  "`run_bash` calls are rejected while this preset is on. `read_file` / `grep` / `glob` / " +
  "`delegate` still work. Need a file changed → `delegate(role=\"worker\", ...)`; need a " +
  "command run → `delegate(role=\"verifier\", ...)`.\n";

export const MCP_SECTION =
  "\n\n## MCP tools\n" +
  "Portable tools (read_file, run_bash, tasks, etc.) are exposed via the " +
  "built-in local MCP server as mcp__local__{tool}.\n" +
  "Use connect_mcp to attach external MCP servers (stdio); their tools appear " +
  "as mcp__{server}__{tool}. Use list_mcp_servers to inspect connections.";

export const SUBAGENT_STOPPED_MESSAGE = "Subagent stopped after 30 turns without final answer.";

export const SUBAGENT_IDENTITY =
  "You are a coding agent at {workspace}. " +
  "Complete the task you were given, then return a concise summary. " +
  "Do not delegate further.";

export const SCOUT_IDENTITY =
  "You are a scout agent specialized in codebase recon at {workspace}.\n" +
  "Your goal is to locate relevant code, trace dependencies, and produce a compact context package for downstream agents.\n" +
  "RULES:\n" +
  "- You must NOT make any changes to files. Only search, read, and inspect.\n" +
  "- Do not delegate further.\n\n" +
  "OUTPUT FORMAT (Must follow strictly):\n" +
  "## Context Overview\n" +
  "Brief 1-2 sentence summary of where relevant logic lives.\n\n" +
  "## Files Located\n" +
  "- `path/to/file.ts:lineStart-lineEnd` - Description of relevance\n\n" +
  "## Key Code & Interfaces\n" +
  "Critical functions, types, and signatures extracted.\n\n" +
  "## Dependencies & Traps\n" +
  "Notable constraints, related test files, or potential pitfalls.";

export const PLANNER_IDENTITY =
  "You are a planning specialist at {workspace}.\n" +
  "Your goal is to produce a step-by-step implementation plan from the user requirements and scouted context.\n" +
  "RULES:\n" +
  "- You must NOT make any changes to files. Only read, analyze, and plan.\n" +
  "- Do not delegate further.\n\n" +
  "OUTPUT FORMAT (Must follow strictly):\n" +
  "## Goal & Scope\n" +
  "Clear statement of objectives and boundaries.\n\n" +
  "## Step-by-Step Plan\n" +
  "1. `path/to/file.ts`: Concrete action and target function\n" +
  "2. ...\n\n" +
  "## Risks & Edge Cases\n" +
  "Potential pitfalls and how to mitigate them.\n\n" +
  "## Acceptance Criteria\n" +
  "- [ ] Test case or verification check";

export const WORKER_IDENTITY =
  "You are a worker implementation agent at {workspace}.\n" +
  "Your goal is to implement the requested changes strictly according to the plan.\n" +
  "RULES:\n" +
  "- Focus on clean, minimal, working changes that directly fulfill the plan.\n" +
  "- Test your changes when appropriate.\n" +
  "- Do not delegate further.\n\n" +
  "OUTPUT FORMAT (Must follow strictly):\n" +
  "## Completed Work\n" +
  "Summary of what was implemented.\n\n" +
  "## Files Changed\n" +
  "- `path/to/file.ts` - Description of changes made\n\n" +
  "## Implementation Notes\n" +
  "Self-test observations, remaining edge cases, or details for the reviewer.";

export const REVIEWER_IDENTITY =
  "You are a senior static code reviewer at {workspace}.\n" +
  "Your goal is to analyze changes for bugs, style, security, and conformance to specifications.\n" +
  "RULES:\n" +
  "- You must NOT modify any files. Bash is restricted to read-only commands (git diff, git log, git status).\n" +
  "- Do not delegate further.\n\n" +
  "OUTPUT FORMAT (Must follow strictly):\n" +
  "## Review Summary\n" +
  "Overall assessment in 2-3 sentences.\n\n" +
  "## Findings\n" +
  "- **[CRITICAL]** `file.ts:line` - Must-fix bug, security flaw, or spec deviation\n" +
  "- **[WARNING]** `file.ts:line` - Code smell, edge case, or maintainability concern\n" +
  "- **[SUGGESTION]** `file.ts:line` - Optional improvement idea\n" +
  "(or 'None' under respective category)\n\n" +
  "## Verdict\n" +
  "[PASS] or [BLOCK] (Any CRITICAL item requires BLOCK)";

export const VERIFIER_IDENTITY =
  "You are a dynamic verification specialist at {workspace}.\n" +
  "Your goal is to run builds, tests, linters, and typecheckers to objectively verify correctness and detect regressions.\n" +
  "RULES:\n" +
  "- You must NOT modify source files. You may execute test, build, and check commands.\n" +
  "- Do not delegate further.\n\n" +
  "OUTPUT FORMAT (Must follow strictly):\n" +
  "## Verification Summary\n" +
  "Overview of tests and checks executed.\n\n" +
  "## Commands Executed\n" +
  "- `<command>`: Result summary (exit code, passed/failed counts)\n\n" +
  "## Failure Details\n" +
  "Error output, assertion failures, or stack traces (or 'None').\n\n" +
  "## Verdict\n" +
  "[PASS] or [BLOCK]";

export function getRoleIdentity(role: AgentRole, workspace: string): string {
  switch (role) {
    case "scout":
      return SCOUT_IDENTITY.replace("{workspace}", workspace);
    case "planner":
      return PLANNER_IDENTITY.replace("{workspace}", workspace);
    case "worker":
      return WORKER_IDENTITY.replace("{workspace}", workspace);
    case "reviewer":
      return REVIEWER_IDENTITY.replace("{workspace}", workspace);
    case "verifier":
      return VERIFIER_IDENTITY.replace("{workspace}", workspace);
    case "subagent":
      return SUBAGENT_IDENTITY.replace("{workspace}", workspace);
    default:
      return AGENT_IDENTITY.replace("{workspace}", workspace);
  }
}

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

export function buildSkillSection(catalog: string): string {
  return `Skills available:\n${catalog}\nUse load_skill to get full details when needed.`;
}

// ── 消息包装（对齐 prompt.py） ─────────────────────────────────────────────

export const RELEVANT_MEMORIES_OPEN = "<relevant_memories>";
export const RELEVANT_MEMORIES_CLOSE = "</relevant_memories>";


export function formatCompactedUserMessage(summary: string): string {
  // 对齐 pi COMPACTION_SUMMARY_PREFIX/SUFFIX（CC 同文）
  return `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${summary}\n</summary>`;
}

export function formatReactiveCompactedUserMessage(summary: string): string {
  return formatCompactedUserMessage(summary);
}

// ── 错误恢复 prompt（03） ──────────────────────────────────────────────────

export const CONTINUATION_PROMPT =
  "Output token limit hit. Resume directly — " +
  "no apology, no recap. Pick up mid-thought.";

// ── Compact LLM 总结 prompt（04） ──────────────────────────────────────────

// pi 式结构化检查点模板（对齐 pi dist/core/compaction/compaction.js
// SUMMARIZATION_PROMPT——文本同源 CC 家族但为 7 节检查点式，替代旧 5 点简版）
export const COMPACT_SUMMARY_TEMPLATE = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

// 更新式模板：已有摘要时增量合并（对齐 pi UPDATE_SUMMARIZATION_PROMPT）
export const COMPACT_UPDATE_TEMPLATE = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Preserve completed, add newly completed]

### In Progress
- [ ] [Preserve in-progress, update state]

### Blocked
- [Preserve blockers, add new ones]

## Key Decisions
- **[Decision]**: [Preserve existing, add new with brief rationale]

## Next Steps
1. [Preserve remaining, update order based on progress]

## Critical Context
- [Preserve important context, add new data/refs]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/**
 * 组装摘要 prompt（pi 式）：<conversation> 包装 + 可选 <previous-summary>
 * （多次压缩走更新式）+ 可选 /compact 指令（Additional focus）。
 */
export function formatCompactSummary(
  conversation: string,
  previousSummary?: string,
  instructions?: string,
): string {
  let prompt = `<conversation>\n${conversation}\n</conversation>\n\n`;
  if (previousSummary) {
    prompt += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
  }
  prompt += previousSummary ? COMPACT_UPDATE_TEMPLATE : COMPACT_SUMMARY_TEMPLATE;
  if (instructions) {
    prompt += `\n\nAdditional focus: ${instructions}`;
  }
  return prompt;
}

// ── Memory LLM 任务 prompt（05） ───────────────────────────────────────────

export const SELECT_MEMORIES_TEMPLATE =
  "Given the recent conversation and the memory catalog below, " +
  "select ONLY the indices of memories that are directly and critically relevant " +
  "to the current task. A memory is worth including only if ignoring it would " +
  "cause a materially wrong answer. " +
  "Return ONLY a JSON array of integers, e.g. [0, 3]. " +
  "If none are relevant, return [].\n\n" +
  "Recent conversation:\n{recent}\n\nMemory catalog:\n{catalog}";

export const EXTRACT_MEMORIES_TEMPLATE =
  "Extract memories ONLY if they meet ANY of these criteria:\n" +
  "1. Established facts or important conclusions about the project or user\n" +
  "2. Overall project goals, architecture decisions, or strategic direction\n" +
  "3. Information that will significantly impact future work across multiple sessions\n" +
  "4. Repeated user instructions or preferences that appear more than once\n" +
  "5. User explicitly asked to remember something\n\n" +
  "Do NOT extract:\n" +
  "- Transient questions about file locations, simple clarifications, or one-off status checks\n" +
  "- Minor preferences stated once without emphasis\n" +
  "- Anything the user is likely to figure out again from context in the next turn\n\n" +
  "If nothing meets the criteria, return [].\n\n" +
  "Return a JSON array. Each item: {name, type, description, body}.\n" +
  "- name: short kebab-case identifier (e.g. 'project-architecture-pattern')\n" +
  "- type: one of 'user' (role/goals), 'feedback' (guidance), " +
  "'project' (project fact), 'reference' (external pointer)\n" +
  "- description: one-line summary for index lookup\n" +
  "- body: full detail in markdown\n\n" +
  "Existing memories:\n{existing}\n\nDialogue:\n{dialogue}";

export const CONSOLIDATE_MEMORIES_TEMPLATE =
  "Consolidate the following memory files. Rules:\n" +
  "1. Merge duplicates into one\n" +
  "2. Remove outdated/contradicted memories\n" +
  "3. Remove transient or low-value memories (one-off questions, minor clarifications)\n" +
  "4. Keep the total under {threshold} memories\n" +
  "5. Preserve high-value memories above all: project goals, architecture decisions, " +
  "repeated user preferences, explicit \"remember\" requests\n" +
  "Return a JSON array. Each item: {name, type, description, body}.\n\n{catalog}";

export function formatSelectMemories(recent: string, catalog: string): string {
  return SELECT_MEMORIES_TEMPLATE.replace("{recent}", recent).replace("{catalog}", catalog);
}

export function formatExtractMemories(existing: string, dialogue: string): string {
  return EXTRACT_MEMORIES_TEMPLATE.replace("{existing}", existing).replace("{dialogue}", dialogue);
}

export function formatConsolidateMemories(catalog: string, threshold: number): string {
  return CONSOLIDATE_MEMORIES_TEMPLATE.replace("{threshold}", String(threshold)).replace(
    "{catalog}",
    catalog,
  );
}

// ── 组装与缓存 ────────────────────────────────────────────────────────────

export interface PromptContext {
  skill_catalog?: string;
  workspace?: string;
  memories?: string;
  enabled_tools?: string[];
  mcp_servers?: string[];
  mcp_tool_count?: number;
  /** 协同模式：pipeline 走角色流水线指令，free 走自由组队指令 */
  team_mode?: "pipeline" | "free";
}

export function assembleSystemPrompt(
  context: PromptContext,
  options: { isSubagent: boolean; role?: AgentRole },
): string {
  const workspace = context.workspace ?? process.cwd();
  const isSpecialist = options.isSubagent || (options.role !== undefined && options.role !== "lead" && options.role !== "teammate");
  const identity = options.role && options.role !== "lead" && options.role !== "teammate"
    ? getRoleIdentity(options.role, workspace)
    : (options.isSubagent ? SUBAGENT_IDENTITY.replace("{workspace}", workspace) : AGENT_IDENTITY.replace("{workspace}", workspace));
  const parts = [identity];
  if (!isSpecialist) {
    // 预设：pipeline 给角色流水线指令，free 给自由组队指令（二选一，不叠加）
    parts.push(
      TASK_PLANNING_SECTION,
      BACKGROUND_TASKS_SECTION,
      context.team_mode === "pipeline" ? PIPELINE_SECTION : TEAMS_SECTION,
      MCP_SECTION,
    );
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
  if (!isSpecialist) {
    parts.push(buildMemorySection(context.memories ?? ""));
  }
  if (parts.length === 1) return parts[0];
  return parts[0] + parts.slice(1).join("");
}

/**
 * 系统提示缓存：lead / teammate / subagent / 专职角色共用一套 key。
 * （此前 lead 走单条缓存、其余角色走 Map，是同一件事的两份实现。）
 * ponytail: 整表 Map，超上限清空；工作集若真变大再换 LRU。
 */
const PROMPT_CACHE_MAX = 32;
const _promptCache = new Map<string, string>();

function contextCacheKey(context: PromptContext, isSubagent: boolean, role?: AgentRole): string {
  return JSON.stringify({ ...context, _isSubagent: isSubagent, _role: role }, Object.keys(context).sort());
}

export function getSystemPrompt(
  context: PromptContext,
  options: { isSubagent: boolean; role?: AgentRole },
): string {
  const { isSubagent, role } = options;
  const key = contextCacheKey(context, isSubagent, role);
  const label = role ?? (isSubagent ? "subagent" : "lead");
  const cached = _promptCache.get(key);
  if (cached !== undefined) {
    console.log(`  \x1b[90m[cache hit] ${label} system prompt unchanged\x1b[0m`);
    return cached;
  }
  const assembled = assembleSystemPrompt(context, options);
  if (_promptCache.size >= PROMPT_CACHE_MAX) _promptCache.clear();
  _promptCache.set(key, assembled);
  console.log(`  \x1b[32m[assembled] ${label} system prompt\x1b[0m`);
  return assembled;
}

/**
 * 收集当前环境状态供 getSystemPrompt 使用。
 * 02a：workspace + 空占位；skill（07）、memory（05）、mcp（19）逐步接入。
 */
/**
 * system 段里的记忆文本 = 冻结快照（MEMORY.md 索引 + 相关性检索正文）。
 * 会话内恒定 ⇒ system 提示逐字节稳定 ⇒ prompt cache 前缀可复用。
 */
function buildFrozenMemoryText(): string {
  const snapshot = peekMemorySnapshot();
  return [snapshot.index, snapshot.injected].filter((part) => part.trim()).join("\n\n");
}

export function updateContext(_context: PromptContext, _messages: unknown[]): PromptContext {
  let mcpServers: string[] = [];
  let mcpToolCount = 0;
  try {
    const hub = getMCPHub();
    mcpServers = hub.listServers();
    mcpToolCount = hub.listTools().length;
  } catch {
    // hub 不可用时保持空
  }
  return {
    skill_catalog: getSkillCatalog(),
    workspace: process.cwd(),
    memories: buildFrozenMemoryText(),
    enabled_tools: [],
    mcp_servers: mcpServers,
    mcp_tool_count: mcpToolCount,
    team_mode: getTeamMode(),
  };
}
