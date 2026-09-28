/**
 * runtime.ts — ToolRuntime：工具抽象 + 注册表 + 执行/校验/角色面（从 tool.ts 拆出）
 *
 * deep module：一次工具调用（参数解析 → 注册表 → L3 截断）收敛于此；
 * 领域实现见各 tools/* pack，注册表是它们的 seam。
 */
import { finalizeToolOutput } from "../compact.ts";
import { sanitizeOpenaiTool, type OpenaiTool } from "../schema-strict.ts";
import { getMCPHub } from "../mcp/hub.ts";
import { isMcpTool } from "../mcp/names.ts";
import { checkPath } from "./path.ts";
import { getAgentContext, type AgentRole } from "../teammates/context.ts";
import { getTeamMode } from "../settings.ts";
import { Tool, type ToolExecContext } from "./core.ts";
export { Tool, buildTool, type ExecuteFn } from "./core.ts";
export type { ToolExecContext } from "./core.ts";
import { RUN_BASH_TOOL } from "./bash.ts";
import {
  READ_FILE_TOOL,
  WRITE_FILE_TOOL,
  EDIT_FILE_TOOL,
  GLOB_TOOL,
  GREP_TOOL,
} from "./file.ts";
import { TODO_WRITE_TOOL } from "./todo.ts";
import { LOAD_SKILL_TOOL } from "./skill.ts";
import {
  CREATE_TASK_TOOL,
  LIST_TASKS_TOOL,
  GET_TASK_TOOL,
  CLAIM_TASK_TOOL,
  COMPLETE_TASK_TOOL,
} from "./tasks-board.ts";
import {
  SUBAGENT_TASK_TOOL,
  DELEGATE_TASK_TOOL,
  CREATE_TEAM_TOOL,
  SPAWN_TEAMMATE_TOOL,
  SEND_MESSAGE_TOOL,
  LIST_TEAMMATES_TOOL,
  SHUTDOWN_TEAMMATE_TOOL,
  SUBAGENT_EXCLUDED,
} from "./agent-tools.ts";


export const BUILTIN_TOOLS: Tool[] = [
  RUN_BASH_TOOL,
  READ_FILE_TOOL,
  WRITE_FILE_TOOL,
  EDIT_FILE_TOOL,
  GLOB_TOOL,
  GREP_TOOL,
  TODO_WRITE_TOOL,
  LOAD_SKILL_TOOL,
  CREATE_TASK_TOOL,
  LIST_TASKS_TOOL,
  GET_TASK_TOOL,
  CLAIM_TASK_TOOL,
  COMPLETE_TASK_TOOL,
  SUBAGENT_TASK_TOOL,
  DELEGATE_TASK_TOOL,
  CREATE_TEAM_TOOL,
  SPAWN_TEAMMATE_TOOL,
  SEND_MESSAGE_TOOL,
  LIST_TEAMMATES_TOOL,
  SHUTDOWN_TEAMMATE_TOOL,
];

export const TOOL_MAP: Map<string, Tool> = new Map(BUILTIN_TOOLS.map((t) => [t.name, t]));

/** 专职 Pipeline 角色工具白名单矩阵（Hard Allowlist） */
export const ROLE_TOOL_ALLOWLIST: Record<string, Set<string>> = {
  scout: new Set([
    "read_file",
    "grep",
    "find_files",
    "list_dir",
    "run_bash",
  ]),
  planner: new Set([
    "read_file",
    "grep",
    "find_files",
    "list_dir",
  ]),
  worker: new Set([
    "read_file",
    "edit_file",
    "write_file",
    "grep",
    "find_files",
    "list_dir",
    "run_bash",
    "todo_write",
  ]),
  reviewer: new Set([
    "read_file",
    "grep",
    "find_files",
    "list_dir",
    "run_bash",
  ]),
  verifier: new Set([
    "read_file",
    "grep",
    "find_files",
    "list_dir",
    "run_bash",
  ]),
};

/**
 * 角色限制的文本描述（fork 子 agent 的「后缀限制」用）。
 * 与执行闸 isToolAllowedForRole 同源，避免提示与真实拦截不一致。
 */
export function describeRoleRestrictions(role: AgentRole): string {
  const allow = ROLE_TOOL_ALLOWLIST[role];
  if (!allow) return "";
  const names = [...allow].sort().join(", ");
  const readOnly = role === "scout" || role === "planner" || role === "reviewer" || role === "verifier";
  return [
    `- 可用工具（白名单，其余一律不可用）: ${names}`,
    readOnly
      ? "- 禁止任何写操作（write_file / edit_file / 破坏性 bash）；越权调用会被运行时直接拒绝"
      : "- 只做被指派的改动范围，不要顺手重构无关代码",
    "- 不要再委派任务（delegate / subagent_task 会被运行时拒绝）",
    "- 只处理这一个任务；产出按上面的契约返回后即结束",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * pipeline 预设下 lead 不得自己落地：写文件与跑命令必须交给 worker / verifier 角色。
 */
export const PIPELINE_LEAD_FORBIDDEN = new Set(["write_file", "edit_file", "run_bash"]);

/**
 * 预设禁令 —— 只在「执行闸」生效，**不动「呈现的工具面」**。
 *
 * 原因：fork 子 agent 复用父的工具面以复用 prompt cache（getOpenaiTools(cachePrefix.role)），
 * 若把 lead 的工具面直接收窄，worker 也会拿不到 write_file（它的角色白名单本来允许）。
 * 所以「看见」与「能执行」在这里刻意分离。
 */
export function isToolBlockedByPreset(role: AgentRole, toolName: string): boolean {
  if (role !== "lead") return false;
  return getTeamMode() === "pipeline" && PIPELINE_LEAD_FORBIDDEN.has(toolName);
}

/** 预设拦截时的可操作提示（告诉模型该怎么绕道，而不是只说「不行」） */
export function presetBlockedMessage(toolName: string): string {
  const hint =
    toolName === "run_bash"
      ? 'delegate(role="verifier", task="<要跑什么、要什么证据>", context="<上游交付物>")'
      : 'delegate(role="worker", task="<要改什么>", context="<上游交付物>")';
  return (
    `Pipeline preset is ON: the lead does not run '${toolName}' itself — it only routes. ` +
    `被禁止的工具：write_file / edit_file / run_bash。改用 ${hint}。`
  );
}

export function isToolAllowedForRole(role: AgentRole, toolName: string): boolean {
  if (role === "lead" || role === "teammate") return true;
  if (role === "subagent") return !SUBAGENT_EXCLUDED.has(toolName);
  const allowlist = ROLE_TOOL_ALLOWLIST[role];
  if (!allowlist) return true;
  return allowlist.has(toolName);
}

/** 扩展注册工具（16）：动态加入注册表 */
export function registerExtensionTool(tool: Tool): void {
  TOOL_MAP.set(tool.name, tool);
}

export function getOpenaiTools(roleOrSubagent: AgentRole | boolean = false): OpenaiTool[] {
  const isSubagent = typeof roleOrSubagent === "boolean" ? roleOrSubagent : (roleOrSubagent !== "lead" && roleOrSubagent !== "teammate");
  const role: AgentRole = typeof roleOrSubagent === "string" ? roleOrSubagent : (isSubagent ? "subagent" : "lead");

  const builtin = [...TOOL_MAP.values()]
    .filter((t) => isToolAllowedForRole(role, t.name))
    .map((t) => sanitizeOpenaiTool(t.name, t.toOpenaiSchema()));

  // MCP 工具（19）：子 agent / 专职角色排除本地工具以外的外部 server（对齐 Python）
  let excluded: Set<string> | undefined;
  if (isSubagent) {
    excluded = new Set(
      getMCPHub()
        .listTools()
        .filter((reg) => reg.serverName !== "local")
        .map((reg) => reg.prefixedName),
    );
  }
  return [...builtin, ...getMCPHub().toOpenaiTools(excluded)];
}

export function getToolParameters(name: string): Record<string, unknown> | null {
  if (isMcpTool(name)) {
    const reg = getMCPHub().getTool(name);
    if (!reg) return null;
    return reg.parameters;
  }
  const tool = TOOL_MAP.get(name);
  if (!tool) return null;
  return tool.parameters;
}

export interface ToolCallLike {
  id?: string;
  type?: string;
  function: { name: string; arguments: string };
}

export async function executeToolCall(
  toolCall: ToolCallLike,
  args?: Record<string, unknown>,
  execCtx?: ToolExecContext,
): Promise<string> {
  const name = toolCall.function.name;

  // 角色门禁：按角色硬白名单校验（展示层过滤之外的第二道执行闸）
  const ctx = getAgentContext();
  if (!isToolAllowedForRole(ctx.role, name)) {
    const reason =
      ctx.role === "subagent"
        ? `Tool '${name}' is not available to subagents`
        : `Role '${ctx.role}' is not allowed to use tool '${name}'`;
    return JSON.stringify({
      status: "error",
      message: reason,
    });
  }
  // Pipeline 预设：lead 只能路由，自己写文件/跑命令会被这里拒掉
  if (isToolBlockedByPreset(ctx.role, name)) {
    return JSON.stringify({ status: "error", message: presetBlockedMessage(name) });
  }

  if (args === undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(toolCall.function.arguments);
    } catch (e) {
      return JSON.stringify({ status: "error", message: `Invalid arguments JSON: ${String(e)}` });
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return JSON.stringify({ status: "error", message: "Arguments must be a JSON object" });
    }
    args = parsed as Record<string, unknown>;
  }

  // MCP 工具（19）：hub 调用
  if (isMcpTool(name)) {
    try {
      return await getMCPHub().callPrefixedTool(name, args);
    } catch (e) {
      return JSON.stringify({ status: "error", message: `MCP error: ${String((e as Error).message)}` });
    }
  }

  const tool = TOOL_MAP.get(name);
  if (!tool) {
    return JSON.stringify({ status: "error", message: `Unknown tool: ${name}` });
  }

  const result = tool.run(args, execCtx);
  const out =
    typeof result === "string"
      ? result
      : result instanceof Promise
        ? String(await result)
        : JSON.stringify(result);
  // L3（CC 式）：所有工具输出统一截断 + 大输出落盘引用
  return finalizeToolOutput(name, toolCall.id, out);
}

// validate_args（由 hook.ts 的 validateHook 调用；对齐 hook.py validate_args）
export function validateArgs(
  args: Record<string, unknown>,
  schema: Record<string, unknown>,
): string | null {
  const required = (schema["required"] as string[]) ?? [];
  const properties = (schema["properties"] as Record<string, { type?: string }>) ?? {};

  for (const key of required) {
    if (!(key in args)) {
      return `Missing required parameter: ${key}`;
    }
  }

  if (schema["additionalProperties"] === false) {
    const extra = Object.keys(args).filter((k) => !(k in properties));
    if (extra.length > 0) {
      return `Unexpected parameters: ${[...extra].sort().join(", ")}`;
    }
  }

  for (const [key, value] of Object.entries(args)) {
    const prop = properties[key];
    if (!prop) continue;
    const expected = prop.type;
    if (expected === "string" && typeof value !== "string") {
      return `Parameter '${key}' must be a string`;
    }
    if (expected === "integer" && typeof value !== "number") {
      return `Parameter '${key}' must be an integer`;
    }
    if (expected === "number" && typeof value !== "number") {
      return `Parameter '${key}' must be a number`;
    }
    if (expected === "array" && !Array.isArray(value)) {
      return `Parameter '${key}' must be a array`;
    }
    if (expected === "boolean" && typeof value !== "boolean") {
      return `Parameter '${key}' must be a boolean`;
    }
  }

  if ("path" in properties && typeof args["path"] === "string") {
    return checkPath(args["path"] as string);
  }
  return null;
}
