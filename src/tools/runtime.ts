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
import { getAgentContext } from "../teammates/context.ts";
import { Tool, buildTool, type ExecuteFn } from "./core.ts";
export { Tool, buildTool, type ExecuteFn } from "./core.ts";
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
  CREATE_TEAM_TOOL,
  SPAWN_TEAMMATE_TOOL,
  SEND_MESSAGE_TOOL,
  LIST_TEAMMATES_TOOL,
  SHUTDOWN_TEAMMATE_TOOL,
];

export const TOOL_MAP: Map<string, Tool> = new Map(BUILTIN_TOOLS.map((t) => [t.name, t]));

/** 扩展注册工具（16）：动态加入注册表 */
export function registerExtensionTool(tool: Tool): void {
  TOOL_MAP.set(tool.name, tool);
}

export function getOpenaiTools(isSubagent = false): OpenaiTool[] {
  const builtin = [...TOOL_MAP.values()]
    .filter((t) => !(isSubagent && SUBAGENT_EXCLUDED.has(t.name)))
    .map((t) => sanitizeOpenaiTool(t.name, t.toOpenaiSchema()));
  // MCP 工具（19）：子 agent 排除本地工具以外的外部 server（对齐 Python）
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
): Promise<string> {
  const name = toolCall.function.name;

  // 角色门禁：subagent 不可直接执行受限工具（展示层 SUBAGENT_EXCLUDED 之外的第二道闸）
  if (getAgentContext().role === "subagent" && SUBAGENT_EXCLUDED.has(name)) {
    return JSON.stringify({
      status: "error",
      message: `Tool '${name}' is not available to subagents`,
    });
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

  const result = tool.run(args);
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
