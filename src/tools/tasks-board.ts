/**
 * tasks-board.ts — 任务看板工具（从 tool.ts 拆出）
 */
import {
  runCreateTask,
  runListTasks,
  runGetTask,
  runClaimTask,
  runCompleteTask,
} from "../tasks.ts";
import { syncTodoFromTasks } from "./todo.ts";
import { buildTool } from "./core.ts";

// ── 任务看板工具（08） ────────────────────────────────────────────────────

function execCreateTask(args: Record<string, unknown>): string {
  const blocked = Array.isArray(args["blockedBy"]) ? (args["blockedBy"] as string[]) : [];
  const result = runCreateTask(
    String(args["subject"]),
    String(args["description"] ?? ""),
    blocked,
  );
  syncTodoFromTasks();
  return result;
}

function execListTasks(args: Record<string, unknown>): string {
  return runListTasks(String(args["status_filter"] ?? "all"));
}

function execGetTask(args: Record<string, unknown>): string {
  return runGetTask(String(args["task_id"]));
}

async function execClaimTask(args: Record<string, unknown>): Promise<string> {
  const result = await runClaimTask(String(args["task_id"]));
  syncTodoFromTasks();
  return result;
}

async function execCompleteTask(args: Record<string, unknown>): Promise<string> {
  const result = await runCompleteTask(String(args["task_id"]));
  syncTodoFromTasks();
  return result;
}

const CREATE_TASK_SCHEMA = {
  type: "object",
  properties: {
    subject: { type: "string", description: "Short task title" },
    description: {
      type: "string",
      description: "Detailed description; use empty string if none",
    },
    blockedBy: {
      type: "array",
      description: "Dependency task IDs; use empty array if none",
      items: { type: "string" },
    },
  },
  required: ["subject", "description", "blockedBy"],
  additionalProperties: false,
};

const LIST_TASKS_SCHEMA = {
  type: "object",
  properties: {
    status_filter: {
      type: "string",
      enum: ["all", "pending", "in_progress", "completed"],
      description: "Filter by status, or 'all' for every task",
    },
  },
  required: ["status_filter"],
  additionalProperties: false,
};

const GET_TASK_SCHEMA = {
  type: "object",
  properties: {
    task_id: { type: "string", description: "Task ID, e.g. task_1" },
  },
  required: ["task_id"],
  additionalProperties: false,
};

const CLAIM_TASK_SCHEMA = {
  type: "object",
  properties: {
    task_id: { type: "string", description: "Task ID to claim" },
  },
  required: ["task_id"],
  additionalProperties: false,
};

const COMPLETE_TASK_SCHEMA = {
  type: "object",
  properties: {
    task_id: { type: "string", description: "Task ID to complete" },
  },
  required: ["task_id"],
  additionalProperties: false,
};

export const CREATE_TASK_TOOL = buildTool({
  name: "create_task",
  description:
    "Plan phase: create a persisted task in .agent/tasks/ (use during initial planning " +
    "for large multi-step goals). Set blockedBy for dependencies; " +
    "blocks on upstream tasks is maintained automatically. " +
    "Pass empty string / empty array when description or blockedBy are not needed. " +
    "Create the full plan before claim_task or implementation tools.",
  parameters: CREATE_TASK_SCHEMA,
  execute: execCreateTask,
  isReadOnly: false,
});

export const LIST_TASKS_TOOL = buildTool({
  name: "list_tasks",
  description: "List persisted tasks, optionally filtered by status.",
  parameters: LIST_TASKS_SCHEMA,
  execute: execListTasks,
  isReadOnly: true,
});

export const GET_TASK_TOOL = buildTool({
  name: "get_task",
  description: "Get full details of a persisted task.",
  parameters: GET_TASK_SCHEMA,
  execute: execGetTask,
  isReadOnly: true,
});

export const CLAIM_TASK_TOOL = buildTool({
  name: "claim_task",
  description:
    "Resolve phase: claim a pending task (creates a git worktree for isolation " +
    "and switches the working directory into it).",
  parameters: CLAIM_TASK_SCHEMA,
  execute: execClaimTask,
  isReadOnly: false,
});

export const COMPLETE_TASK_TOOL = buildTool({
  name: "complete_task",
  description: "Complete a claimed task (removes its worktree and restores the working directory).",
  parameters: COMPLETE_TASK_SCHEMA,
  execute: execCompleteTask,
  isReadOnly: false,
});

// ── subagent（09） ─────────────────────────────────────────────────────────
