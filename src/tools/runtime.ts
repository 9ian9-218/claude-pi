/**
 * runtime.ts — ToolRuntime：工具抽象 + 注册表 + 执行/校验/角色面（从 tool.ts 拆出）
 *
 * deep module：一次工具调用（参数解析 → 注册表 → L3 截断）收敛于此；
 * 领域实现见各 tools/* pack，注册表是它们的 seam。
 */
import { finalizeToolOutput } from "../compact.ts";
import { sanitizeOpenaiTool, type OpenaiTool } from "../schema-strict.ts";
import { getMCPHub, McpCallError } from "../mcp/hub.ts";
import { finalizeMcpToolOutput } from "../mcp/output.ts";
import { isMcpTool } from "../mcp/names.ts";
import { checkPath } from "./path.ts";
import { getAgentContext, type AgentRole } from "../teammates/context.ts";
import { getTeamMode } from "../settings.ts";
import { Tool, type ToolExecContext } from "./core.ts";
import { errorResult, toolResult, type ToolResult } from "../results.ts";
import { currentBudget, BudgetExceeded } from "../task-budget.ts";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import { instructionText, instructionHash } from "../repository-context.ts";
export { Tool, buildTool, type ExecuteFn } from "./core.ts";
export type { ToolExecContext } from "./core.ts";
import { RUN_BASH_TOOL } from "./bash.ts";
import { CONNECT_MCP_TOOL, DISCONNECT_MCP_TOOL, RESTART_MCP_TOOL, LIST_MCP_SERVERS_TOOL } from "./mcp.ts";
import { REPOSITORY_INFO_TOOL, SYMBOL_SEARCH_TOOL } from "./repository.ts";
import { BACKGROUND_JOB_TOOL } from "./jobs.ts";
import { RUN_VERIFICATION_TOOL } from "./verification.ts";
import {
  READ_FILE_TOOL,
  WRITE_FILE_TOOL,
  EDIT_FILE_TOOL,
  GLOB_TOOL,
  GREP_TOOL,
  APPLY_PATCH_TOOL,
  RESTORE_CHECKPOINT_TOOL,
} from "./file.ts";
import { TODO_WRITE_TOOL } from "./todo.ts";
import { LOAD_SKILL_TOOL } from "./skill.ts";
import {
  CREATE_TASK_TOOL,
  LIST_TASKS_TOOL,
  GET_TASK_TOOL,
  CLAIM_TASK_TOOL,
  COMPLETE_TASK_TOOL,
  INTEGRATE_TASK_TOOL,
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
  RUN_VERIFICATION_TOOL,
  BACKGROUND_JOB_TOOL,
  REPOSITORY_INFO_TOOL,
  SYMBOL_SEARCH_TOOL,
  READ_FILE_TOOL,
  WRITE_FILE_TOOL,
  EDIT_FILE_TOOL,
  GLOB_TOOL,
  GREP_TOOL,
  APPLY_PATCH_TOOL,
  RESTORE_CHECKPOINT_TOOL,
  TODO_WRITE_TOOL,
  LOAD_SKILL_TOOL,
  CREATE_TASK_TOOL,
  LIST_TASKS_TOOL,
  GET_TASK_TOOL,
  CLAIM_TASK_TOOL,
  COMPLETE_TASK_TOOL,
  INTEGRATE_TASK_TOOL,
  SUBAGENT_TASK_TOOL,
  DELEGATE_TASK_TOOL,
  CREATE_TEAM_TOOL,
  SPAWN_TEAMMATE_TOOL,
  SEND_MESSAGE_TOOL,
  LIST_TEAMMATES_TOOL,
  SHUTDOWN_TEAMMATE_TOOL,
  CONNECT_MCP_TOOL,
  DISCONNECT_MCP_TOOL,
  RESTART_MCP_TOOL,
  LIST_MCP_SERVERS_TOOL,
];

export const TOOL_MAP: Map<string, Tool> = new Map(BUILTIN_TOOLS.map((t) => [t.name, t]));

/** 专职 Pipeline 角色工具白名单矩阵（Hard Allowlist） */
export const ROLE_TOOL_ALLOWLIST: Record<string, Set<string>> = {
  scout: new Set([
    "read_file",
    "grep",
    "glob",
    "run_bash",
  ]),
  planner: new Set([
    "read_file",
    "grep",
    "glob",
  ]),
  worker: new Set([
    "read_file",
    "edit_file",
    "write_file",
    "grep",
    "glob",
    "apply_patch",
    "restore_checkpoint",
    "run_bash",
    "todo_write",
  ]),
  reviewer: new Set([
    "read_file",
    "grep",
    "glob",
    "run_bash",
  ]),
  verifier: new Set([
    "read_file",
    "grep",
    "glob",
    "run_bash",
  ]),
};
for (const [role, allow] of Object.entries(ROLE_TOOL_ALLOWLIST)) { allow.add("repository_info"); allow.add("symbol_search"); if (role === "worker" || role === "verifier") allow.add("run_verification"); }

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
export const PIPELINE_LEAD_FORBIDDEN = new Set(["write_file", "edit_file", "apply_patch", "restore_checkpoint", "run_bash", "run_verification"]);

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
  if (["connect_mcp", "disconnect_mcp", "restart_mcp", "list_mcp_servers"].includes(toolName)) return role === "lead";
  if (role === "lead" || role === "teammate") return true;
  if (isMcpTool(toolName) && !toolName.startsWith("mcp__local__")) return false;
  if (role === "subagent") return !SUBAGENT_EXCLUDED.has(toolName);
  const allowlist = ROLE_TOOL_ALLOWLIST[role];
  if (!allowlist) return true;
  return allowlist.has(toolName);
}

/** 扩展注册工具（16）：动态加入注册表 */
export function registerExtensionTool(tool: Tool): () => void {
  if (BUILTIN_TOOLS.some(t => t.name === tool.name)) throw new Error(`Extensions cannot replace built-in tool '${tool.name}'`);
  const previous = TOOL_MAP.get(tool.name);
  TOOL_MAP.set(tool.name, tool);
  return () => { if (TOOL_MAP.get(tool.name) === tool) { if (previous) TOOL_MAP.set(tool.name, previous); else TOOL_MAP.delete(tool.name); } };
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
  return (await executeToolCallResult(toolCall, args, execCtx)).output;
}

export async function executeToolCallResult(
  toolCall: ToolCallLike,
  args?: Record<string, unknown>,
  execCtx?: ToolExecContext,
): Promise<ToolResult> {
  // Local MCP aliases execute in this process and keep the caller's capabilities.
  const name = toolCall.function.name.startsWith("mcp__local__") ? toolCall.function.name.slice("mcp__local__".length) : toolCall.function.name;

  // 角色门禁：按角色硬白名单校验（展示层过滤之外的第二道执行闸）
  const ctx = getAgentContext();
  if (!isToolAllowedForRole(ctx.role, name)) {
    const reason =
      ctx.role === "subagent"
        ? `Tool '${name}' is not available to subagents`
        : `Role '${ctx.role}' is not allowed to use tool '${name}'`;
    return errorResult(reason);
  }
  // Pipeline 预设：lead 只能路由，自己写文件/跑命令会被这里拒掉
  if (isToolBlockedByPreset(ctx.role, name)) {
    return errorResult(presetBlockedMessage(name));
  }

  if (args === undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(toolCall.function.arguments);
    } catch (e) {
      return errorResult(`Invalid arguments JSON: ${String(e)}`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return errorResult("Arguments must be a JSON object");
    }
    args = parsed as Record<string, unknown>;
  }

  try {
    currentBudget()?.useTool();
    const schema = getToolParameters(name);
    if (!schema) return errorResult(`Unknown tool: ${name}`);
    // Strict OpenAI tool schemas represent omitted optional fields as null.
    // Normalize only genuinely optional, non-nullable original parameters.
    args = structuredClone(args);
    const required = (schema.required ?? []) as string[];
    const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    for (const [key, value] of Object.entries(args)) {
      const prop = properties[key];
      if (value === null && prop && !required.includes(key) && prop.type !== "null" && !Array.isArray(prop.anyOf) && !Array.isArray(prop.oneOf) && !Array.isArray(prop.type)) delete args[key];
    }
    const invalid = validateArgs(args, schema);
    if (invalid) return errorResult(invalid);
    args = freezeInput(args);
    const { permissionHookWithBubble } = await import("../permission-sync.ts");
    const denied = await permissionHookWithBubble({ name, input: args, id: toolCall.id });
    if (denied) return errorResult(denied);
    const { triggerToolHooks, triggerHooks } = await import("../hook.ts");
    const block = { name, input: args, id: toolCall.id };
    const blocked = await triggerToolHooks(block);
    if (blocked !== undefined && blocked !== null) return errorResult(String(blocked));
    const paths = name === "apply_patch" ? (args.edits as Array<{ path: string }>).map(e => e.path) : ["write_file", "edit_file"].includes(name) ? [String(args.path)] : [];
    for (const path of paths) {
      const text = instructionText(path);
      const budget = currentBudget();
      if (text && budget && !budget.seenInstructions.has(instructionHash(text))) {
        budget.seenInstructions.add(instructionHash(text));
        return errorResult(`Review these scoped repository instructions before retrying the edit:${text}`);
      }
    }
    if (execCtx?.signal?.aborted) return { status: "cancelled", output: "Error: tool cancelled before execution" };
    if (["write_file", "edit_file", "apply_patch", "restore_checkpoint", "run_bash", "run_verification"].includes(name) && ctx.role !== "verifier") {
      const { requireWritableWorkspace } = await import("../workspaces.ts");
      requireWritableWorkspace();
    }
    if (execCtx?.allowBackground && name === "run_bash") {
      const { shouldRunBackground, startBackgroundTask } = await import("../background-task.ts");
      if (shouldRunBackground(name, args)) {
        const id = startBackgroundTask({ ...toolCall, function: { ...toolCall.function, name } }, args, { signal: execCtx.signal });
        return { status: "success", output: `[Background task ${id} started] Command: ${String(args.command)}. Output will arrive as a <task_notification> user message when the task completes or stalls.` };
      }
    }
    const value = isMcpTool(name) ? await getMCPHub().callPrefixedTool(name, args, execCtx?.signal) : await TOOL_MAP.get(name)!.run(args, execCtx);
    const result = toolResult(value);
    await triggerHooks("PostToolUse", block, result.output);
    return { ...result, output: isMcpTool(name) ? await finalizeMcpToolOutput(result.output) : finalizeToolOutput(name, toolCall.id, result.output) };
  } catch (e) {
    if (e instanceof BudgetExceeded) return { status: "budget_exceeded", output: `Error: ${e.message}` };
    if (e instanceof McpCallError) return { status: e.status, output: JSON.stringify({ status: e.status, message: e.message }) };
    return errorResult(`Tool '${name}' failed: ${String((e as Error)?.message ?? e)}`);
  }
}

function freezeInput<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeInput(child);
    Object.freeze(value);
  }
  return value;
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
    if (expected === "integer" && (typeof value !== "number" || !Number.isInteger(value))) {
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

  const nestedError = validateSchemaValue(args, schema);
  if (nestedError) return nestedError;
  try {
    let validate = schemaValidators.get(schema);
    if (!validate) { validate = schemaValidator.compile(schema); schemaValidators.set(schema, validate); }
    if (!validate(args)) return `Invalid arguments: ${schemaValidator.errorsText(validate.errors)}`;
  } catch { return "Tool schema cannot be validated; execution refused"; }

  if ("path" in properties && typeof args["path"] === "string") {
    return checkPath(args["path"] as string);
  }
  return null;
}

const schemaValidator = new Ajv2020({ strict: false, allErrors: false, validateFormats: false });
const schemaValidators = new WeakMap<object, ValidateFunction>();

function validateSchemaValue(value: unknown, schema: Record<string, unknown>, at = "arguments"): string | null {
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return `${at}: value is not in enum`;
  if (schema.type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return `${at}: expected object`;
    const object = value as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    for (const key of (schema.required ?? []) as string[]) if (!(key in object)) return `${at}: Missing required parameter: ${key}`;
    if (schema.additionalProperties === false) for (const key of Object.keys(object)) if (!(key in props)) return `${at}: Unexpected parameter: ${key}`;
    for (const [key, prop] of Object.entries(props)) if (key in object) {
      const err = validateSchemaValue(object[key], prop, `${at}.${key}`); if (err) return err;
    }
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) return `${at}: expected array`;
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return `${at}: too few items`;
    if (schema.items) for (const item of value) { const err = validateSchemaValue(item, schema.items as Record<string, unknown>, at); if (err) return err; }
  }
  if (schema.type === "string" && typeof value !== "string") return `${at}: expected string`;
  if (schema.type === "boolean" && typeof value !== "boolean") return `${at}: expected boolean`;
  if (schema.type === "integer" && !Number.isInteger(value)) return `${at}: expected integer`;
  if (schema.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) return `${at}: expected number`;
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return `${at}: below minimum`;
    if (typeof schema.maximum === "number" && value > schema.maximum) return `${at}: above maximum`;
  }
  return null;
}
