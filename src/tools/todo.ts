/**
 * todo.ts — todo_write 工具（从 tool.ts 拆出）
 */
import { listTasks } from "../tasks.ts";
import { buildTool } from "./core.ts";

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

/** 从持久化任务看板刷新 todo（对齐 _sync_todo_from_tasks） */
export function syncTodoFromTasks(): void {
  const tasks = listTasks();
  if (tasks.length === 0) return;
  CURRENT_TODOS = tasks.map((t) => ({
    content: `[${t.id}] ${t.subject}`,
    status: t.status === "ready_for_review" ? "in_progress" : t.status,
  }));
  formatTodoBoard();
}

function execTodoWrite(args: Record<string, unknown>): string {
  const todos = args["todos"];
  if (!Array.isArray(todos) || todos.length === 0) {
    syncTodoFromTasks();
    if (CURRENT_TODOS.length > 0) return formatTodoBoard(true);
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
  CURRENT_TODOS = structuredClone(todos) as TodoItem[];
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
