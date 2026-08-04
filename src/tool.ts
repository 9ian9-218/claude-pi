/**
 * tool.ts — 工具抽象与内置工具（对齐 src/tool.py）
 *
 * 一次工具调用流程：agent-loop 解析参数 → PreToolUse hook（validate/permission/log）
 * → Tool.run(args) → PostToolUse hook → 结果 JSON 序列化回 messages。
 *
 * 02b 范围：文件工具 + run_bash（前台）+ todo_write。
 * background（06）、subagent/teammates/mcp 工具（09/10/19）、memory 索引联动（05）后续接入。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { globSync } from "glob";
import { getWorkdir } from "./workdir.ts";
import { sanitizeOpenaiTool, type OpenaiTool } from "./schema-strict.ts";
import { getSkillContent } from "./skill-load.ts";

export type ExecuteFn = (args: Record<string, unknown>) => unknown;

/** Tool 核心抽象（对齐 Python frozen dataclass） */
export class Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly execute: ExecuteFn;
  readonly isReadOnly: boolean;

  constructor(init: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    execute: ExecuteFn;
    isReadOnly?: boolean;
  }) {
    this.name = init.name;
    this.description = init.description;
    this.parameters = init.parameters;
    this.execute = init.execute;
    this.isReadOnly = init.isReadOnly ?? false;
  }

  toOpenaiSchema(): OpenaiTool {
    return {
      type: "function",
      function: {
        name: this.name,
        description: this.description,
        parameters: this.parameters,
      },
    };
  }

  run(args: Record<string, unknown>): unknown {
    return this.execute(args);
  }
}

export function buildTool(init: ConstructorParameters<typeof Tool>[0]): Tool {
  return new Tool(init);
}

// ── 路径校验 ──────────────────────────────────────────────────────────────

/** 检查路径是否在工作区内，返回错误信息或 null */
export function checkPath(p: string): string | null {
  const wd = path.resolve(getWorkdir());
  const target = path.resolve(wd, p);
  if (target !== wd && !target.startsWith(wd + path.sep)) {
    return `Path escapes workspace: ${p}`;
  }
  return null;
}

/** 解析并返回工作区内安全路径（逃逸时抛错） */
export function safePath(p: string): string {
  const err = checkPath(p);
  if (err !== null) throw new Error(err);
  return path.resolve(getWorkdir(), p);
}

// ── run_bash ──────────────────────────────────────────────────────────────

const BASH_TIMEOUT_MS = 120_000;
const BASH_MAX_OUTPUT = 50_000;

function execRunBash(args: Record<string, unknown>): string {
  const command = String(args["command"]);
  try {
    const r = spawnSync(command, {
      cwd: getWorkdir(),
      shell: true,
      encoding: "utf8",
      timeout: BASH_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (r.status === null) {
      return "Error: Timeout (120s)";
    }
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
    if (!out) return "(no output)";
    return out.slice(0, BASH_MAX_OUTPUT);
  } catch (e) {
    return `Error: ${String(e)}`;
  }
}

const BASH_SCHEMA = {
  type: "object",
  properties: {
    command: { type: "string", description: "The command to run" },
    run_in_background: {
      type: "boolean",
      description: "Whether to run the command in background",
    },
  },
  required: ["command", "run_in_background"],
  additionalProperties: false,
};

export const RUN_BASH_TOOL = buildTool({
  name: "run_bash",
  description: "Run a shell command. Use when the user asks to run a command.",
  parameters: BASH_SCHEMA,
  execute: execRunBash,
  isReadOnly: false,
});

// ── read_file ─────────────────────────────────────────────────────────────

function execReadFile(args: Record<string, unknown>): string {
  const p = String(args["path"]);
  try {
    return fs.readFileSync(safePath(p), "utf8").replace(/\n$/, "");
  } catch (e) {
    return `Error: ${String(e)}`;
  }
}

const READ_SCHEMA = {
  type: "object",
  properties: {
    path: { type: "string", description: "The path of the file to read" },
  },
  required: ["path"],
  additionalProperties: false,
};

export const READ_FILE_TOOL = buildTool({
  name: "read_file",
  description: "Read file contents at a specific path.",
  parameters: READ_SCHEMA,
  execute: execReadFile,
  isReadOnly: true,
});

// ── write_file ────────────────────────────────────────────────────────────

function execWriteFile(args: Record<string, unknown>): string {
  const p = String(args["path"]);
  const content = String(args["content"]);
  try {
    const filePath = safePath(p);
    fs.writeFileSync(filePath, content);
    return `Wrote ${Buffer.byteLength(content)} bytes to ${p}`;
  } catch (e) {
    return `Error: ${String(e)}`;
  }
}

const WRITE_SCHEMA = {
  type: "object",
  properties: {
    path: { type: "string", description: "The path of the file to write" },
    content: { type: "string", description: "The content to write into the file" },
  },
  required: ["path", "content"],
  additionalProperties: false,
};

export const WRITE_FILE_TOOL = buildTool({
  name: "write_file",
  description: "Write content to a file at a specific path.",
  parameters: WRITE_SCHEMA,
  execute: execWriteFile,
  isReadOnly: false,
});

// ── edit_file ─────────────────────────────────────────────────────────────

function execEditFile(args: Record<string, unknown>): string {
  const p = String(args["path"]);
  const oldText = String(args["old_text"]);
  const newText = String(args["new_text"]);
  try {
    const filePath = safePath(p);
    const text = fs.readFileSync(filePath, "utf8");
    if (!text.includes(oldText)) {
      return "Error: text not found";
    }
    fs.writeFileSync(filePath, text.replace(oldText, newText)); // 只替换第一处
    return `Edited ${p}`;
  } catch (e) {
    return `Error: ${String(e)}`;
  }
}

const EDIT_SCHEMA = {
  type: "object",
  properties: {
    path: { type: "string", description: "The path of the file to edit" },
    old_text: { type: "string", description: "Exact text to replace" },
    new_text: { type: "string", description: "Replacement text" },
  },
  required: ["path", "old_text", "new_text"],
  additionalProperties: false,
};

export const EDIT_FILE_TOOL = buildTool({
  name: "edit_file",
  description: "Replace exact text in a file once.",
  parameters: EDIT_SCHEMA,
  execute: execEditFile,
  isReadOnly: false,
});

// ── glob ──────────────────────────────────────────────────────────────────

function execGlob(args: Record<string, unknown>): string {
  const pattern = String(args["pattern"]);
  try {
    const recursive = pattern.includes("**");
    return globSync(pattern, { cwd: getWorkdir(), nodir: true }).join("\n");
  } catch (e) {
    return `Error: ${String(e)}`;
  }
}

const GLOB_SCHEMA = {
  type: "object",
  properties: {
    pattern: {
      type: "string",
      description:
        "Glob pattern relative to WORKDIR (e.g. '**/*.py', '.claude/skills/*'). Match case exactly — Linux is case-sensitive.",
    },
  },
  required: ["pattern"],
  additionalProperties: false,
};

export const GLOB_TOOL = buildTool({
  name: "glob",
  description:
    "Match and list files using a glob pattern. Paths are relative to WORKDIR; match case exactly (Linux is case-sensitive).",
  parameters: GLOB_SCHEMA,
  execute: execGlob,
  isReadOnly: true,
});

// ── todo_write ────────────────────────────────────────────────────────────

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export let CURRENT_TODOS: TodoItem[] = [];

function formatTodoBoard(updated = false): string {
  const lines = ["\n\x1b[33m## Tasks Progress\x1b[0m"];
  for (const t of CURRENT_TODOS) {
    const icon =
      t.status === "pending" ? " " : t.status === "in_progress" ? "\x1b[36m▸\x1b[0m" : "\x1b[32m✓\x1b[0m";
    lines.push(`  [${icon}] ${t.content}`);
  }
  const board = lines.join("\n");
  if (updated) return board;
  console.log(board);
  return `Showing ${CURRENT_TODOS.length} tasks`;
}

function execTodoWrite(args: Record<string, unknown>): string {
  const todos = args["todos"];
  if (!Array.isArray(todos) || todos.length === 0) {
    // 08：接入任务看板同步（_sync_todo_from_tasks）
    return "No tasks yet.";
  }
  for (let i = 0; i < todos.length; i++) {
    const t = todos[i] as Partial<TodoItem>;
    if (typeof t.content !== "string" || typeof t.status !== "string") {
      return `Error: todos[${i}] missing 'content' or 'status'`;
    }
    if (!["pending", "in_progress", "completed"].includes(t.status)) {
      return `Error: todos[${i}] has invalid status '${t.status}'`;
    }
  }
  CURRENT_TODOS = todos as TodoItem[];
  return formatTodoBoard(true);
}

const TODO_WRITE_SCHEMA = {
  type: "object",
  properties: {
    todos: {
      type: "array",
      description: "Task list for the current coding session",
      items: {
        type: "object",
        properties: {
          content: { type: "string", description: "Task description" },
          status: {
            type: "string",
            description: "Task status",
            enum: ["pending", "in_progress", "completed"],
          },
        },
        required: ["content", "status"],
        additionalProperties: false,
      },
    },
  },
  required: ["todos"],
  additionalProperties: false,
};

export const TODO_WRITE_TOOL = buildTool({
  name: "todo_write",
  description:
    "Visual progress board for the current session's persisted tasks. " +
    "Auto-synced with create_task/claim_task/complete_task — " +
    "read it to see task status at a glance without calling list_tasks. " +
    "Use todo_write to manually refresh the display or add micro-items " +
    "for the current step.",
  parameters: TODO_WRITE_SCHEMA,
  execute: execTodoWrite,
  isReadOnly: true,
});

// ── load_skill ─────────────────────────────────────────────────────────────

function execLoadSkill(args: Record<string, unknown>): string {
  const name = String(args["name"]);
  const content = getSkillContent(name);
  if (content === null) {
    return `Skill not found: ${name}`;
  }
  return content;
}

const LOAD_SKILL_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", description: "The name of the skill to load" },
  },
  required: ["name"],
  additionalProperties: false,
};

export const LOAD_SKILL_TOOL = buildTool({
  name: "load_skill",
  description: "Load the full content of a skill by name.",
  parameters: LOAD_SKILL_SCHEMA,
  execute: execLoadSkill,
  isReadOnly: true,
});

// ── 注册表与对外 API ──────────────────────────────────────────────────────

export const BUILTIN_TOOLS: Tool[] = [
  RUN_BASH_TOOL,
  READ_FILE_TOOL,
  WRITE_FILE_TOOL,
  EDIT_FILE_TOOL,
  GLOB_TOOL,
  TODO_WRITE_TOOL,
  LOAD_SKILL_TOOL,
];

export const TOOL_MAP: Map<string, Tool> = new Map(BUILTIN_TOOLS.map((t) => [t.name, t]));

export function getOpenaiTools(_isSubagent = false): OpenaiTool[] {
  // 09：子 agent 工具限制在此接入
  return BUILTIN_TOOLS.map((t) => sanitizeOpenaiTool(t.name, t.toOpenaiSchema()));
}

export function getToolParameters(name: string): Record<string, unknown> | null {
  const tool = TOOL_MAP.get(name);
  if (!tool) return null;
  return tool.parameters;
}

export interface ToolCallLike {
  id?: string;
  type?: string;
  function: { name: string; arguments: string };
}

export function executeToolCall(
  toolCall: ToolCallLike,
  args?: Record<string, unknown>,
): string {
  const name = toolCall.function.name;

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

  const tool = TOOL_MAP.get(name);
  if (!tool) {
    return JSON.stringify({ status: "error", message: `Unknown tool: ${name}` });
  }

  const result = tool.run(args);
  if (typeof result === "string") return result;
  return JSON.stringify(result);
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
