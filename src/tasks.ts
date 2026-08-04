/**
 * tasks.ts — 持久化任务看板（对齐 src/tasks.py）
 *
 * .agent/tasks/task_<n>.json + highwatermark；blockedBy 依赖图 + blocks 反向索引；
 * claim → worktree 隔离 + workdir 切换；complete → 清理 + 恢复 + 解除下游阻塞。
 */
import fs from "node:fs";
import path from "node:path";
import { AGENT_ROOT, resolveAgentDirs } from "./config.ts";
import { withFileLock } from "./file-lock.ts";
import { createTaskWorktree, removeTaskWorktree } from "./worktree.ts";
import { getWorkdir, setWorktreeOverride } from "./workdir.ts";

// 测试可注入；默认 .agent/tasks
let tasksDir: string = resolveAgentDirs(AGENT_ROOT).tasksDir;

export function setTasksDir(dir: string): void {
  tasksDir = dir;
}

export interface Task {
  id: string;
  subject: string;
  description: string;
  status: "pending" | "in_progress" | "completed";
  owner: string | null;
  blockedBy: string[];
  blocks: string[];
}

function highwatermarkFile(): string {
  return path.join(tasksDir, ".highwatermark");
}

function taskPath(taskId: string): string {
  return path.join(tasksDir, `${taskId}.json`);
}

function taskLockPath(taskId: string): string {
  return `${taskPath(taskId)}.lock`;
}

export function parseTaskNum(taskId: string): number | null {
  if (!taskId.startsWith("task_")) return null;
  const n = Number(taskId.split("_", 2)[1]);
  return Number.isInteger(n) ? n : null;
}

function readHighwatermark(): number {
  try {
    return Number(fs.readFileSync(highwatermarkFile(), "utf8").trim()) || 0;
  } catch {
    return 0;
  }
}

function writeHighwatermark(value: number): void {
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(highwatermarkFile(), `${value}\n`);
}

function maxIdFromTaskFiles(): number {
  let maxId = 0;
  for (const f of fs.readdirSync(tasksDir).filter((f) => f.startsWith("task_") && f.endsWith(".json"))) {
    const num = parseTaskNum(path.basename(f, ".json"));
    if (num !== null) maxId = Math.max(maxId, num);
  }
  return maxId;
}

export function allocateTaskId(): string {
  const nextId = Math.max(readHighwatermark(), maxIdFromTaskFiles()) + 1;
  writeHighwatermark(nextId);
  return `task_${nextId}`;
}

// ── 依赖图 ──────────────────────────────────────────────────────────────

export function buildDependencyGraph(
  extraNodes?: Record<string, string[]>,
): Record<string, string[]> {
  const graph: Record<string, string[]> = {};
  for (const t of listTasks()) graph[t.id] = [...t.blockedBy];
  if (extraNodes) {
    for (const [k, v] of Object.entries(extraNodes)) graph[k] = [...v];
  }
  return graph;
}

export function taskGraphHasCycle(graph?: Record<string, string[]>): boolean {
  const g = graph ?? buildDependencyGraph();
  const visited = new Set<string>();
  const stack = new Set<string>();

  const dfs = (node: string): boolean => {
    if (stack.has(node)) return true;
    if (visited.has(node)) return false;
    visited.add(node);
    stack.add(node);
    for (const dep of g[node] ?? []) {
      if (!(dep in g)) continue;
      if (dfs(dep)) return true;
    }
    stack.delete(node);
    return false;
  };

  for (const node of Object.keys(g)) {
    if (!visited.has(node) && dfs(node)) return true;
  }
  return false;
}

function taskFromDict(data: Record<string, unknown>): Task {
  return {
    id: String(data["id"]),
    subject: String(data["subject"]),
    description: String(data["description"] ?? ""),
    status: (data["status"] ?? "pending") as Task["status"],
    owner: (data["owner"] as string | null) ?? null,
    blockedBy: Array.isArray(data["blockedBy"]) ? (data["blockedBy"] as string[]) : [],
    blocks: Array.isArray(data["blocks"]) ? (data["blocks"] as string[]) : [],
  };
}

// blocks 反向索引（每进程首次访问同步一次，对齐 Python _blocks_index_synced）
let blocksIndexSynced = false;

export function resetBlocksIndex(): void {
  blocksIndexSynced = false;
}

export function ensureBlocksIndex(): void {
  if (blocksIndexSynced) return;
  const paths = fs.existsSync(tasksDir)
    ? fs.readdirSync(tasksDir).filter((f) => f.startsWith("task_") && f.endsWith(".json"))
    : [];
  if (paths.length === 0) {
    blocksIndexSynced = true;
    return;
  }
  const tasks = paths.map((f) => taskFromDict(JSON.parse(fs.readFileSync(path.join(tasksDir, f), "utf8"))));
  const blocksMap: Record<string, string[]> = Object.fromEntries(tasks.map((t) => [t.id, []]));
  for (const t of tasks) {
    for (const depId of t.blockedBy) {
      if (depId in blocksMap && !blocksMap[depId].includes(t.id)) {
        blocksMap[depId].push(t.id);
      }
    }
  }
  for (const t of tasks) {
    const newBlocks = blocksMap[t.id].sort();
    if (JSON.stringify(t.blocks) !== JSON.stringify(newBlocks)) {
      t.blocks = newBlocks;
      saveTask(t);
    }
  }
  blocksIndexSynced = true;
}

export function addBlock(downstreamId: string, blockedBy: string[]): void {
  for (const upstreamId of blockedBy) {
    const upstream = loadTask(upstreamId);
    if (!upstream.blocks.includes(downstreamId)) {
      upstream.blocks.push(downstreamId);
      saveTask(upstream);
    }
  }
}

export function validateCreateTaskDependencies(
  taskId: string,
  blockedBy: string[],
): string | null {
  if (blockedBy.includes(taskId)) {
    return `Task ${taskId} cannot depend on itself`;
  }
  for (const dep of blockedBy) {
    if (!fs.existsSync(taskPath(dep))) {
      return `Unknown dependency: ${dep}`;
    }
  }
  const graph = buildDependencyGraph({ [taskId]: blockedBy });
  if (taskGraphHasCycle(graph)) {
    return "blockedBy would create a cyclic dependency; " +
      "fix the dependency chain so tasks can complete in order";
  }
  return null;
}

export function createTask(
  subject: string,
  description = "",
  blockedBy: string[] = [],
): Task {
  const nextNum = Math.max(readHighwatermark(), maxIdFromTaskFiles()) + 1;
  const taskId = `task_${nextNum}`;
  const err = validateCreateTaskDependencies(taskId, blockedBy);
  if (err) throw new Error(err);

  writeHighwatermark(nextNum);
  const task: Task = {
    id: taskId,
    subject,
    description,
    status: "pending",
    owner: null,
    blockedBy,
    blocks: [],
  };
  saveTask(task);
  addBlock(taskId, blockedBy);
  return task;
}

export function saveTask(task: Task): void {
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(taskPath(task.id), JSON.stringify(task, null, 2));
}

export function loadTask(taskId: string): Task {
  ensureBlocksIndex();
  return taskFromDict(JSON.parse(fs.readFileSync(taskPath(taskId), "utf8")));
}

export function listTasks(): Task[] {
  ensureBlocksIndex();
  if (!fs.existsSync(tasksDir)) return [];
  const tasks = fs
    .readdirSync(tasksDir)
    .filter((f) => f.startsWith("task_") && f.endsWith(".json"))
    .map((f) => taskFromDict(JSON.parse(fs.readFileSync(path.join(tasksDir, f), "utf8"))));
  tasks.sort((a, b) => (parseTaskNum(a.id) ?? 0) - (parseTaskNum(b.id) ?? 0));
  return tasks;
}

export function getTask(taskId: string): string {
  const task = loadTask(taskId);
  return JSON.stringify(task, null, 2);
}

export function canStart(taskId: string): boolean {
  const task = loadTask(taskId);
  const tasks = loadAllTasksRaw();
  return depsSatisfied(task, unresolvedTaskIds(tasks));
}

// ── 内部辅助 ─────────────────────────────────────────────────────────────

function loadAllTasksRaw(): Task[] {
  if (!fs.existsSync(tasksDir)) return [];
  const tasks = fs
    .readdirSync(tasksDir)
    .filter((f) => f.startsWith("task_") && f.endsWith(".json"))
    .map((f) => taskFromDict(JSON.parse(fs.readFileSync(path.join(tasksDir, f), "utf8"))));
  tasks.sort((a, b) => (parseTaskNum(a.id) ?? 0) - (parseTaskNum(b.id) ?? 0));
  return tasks;
}

function unresolvedTaskIds(tasks: Task[]): Set<string> {
  return new Set(tasks.filter((t) => t.status !== "completed").map((t) => t.id));
}

function depsSatisfied(task: Task, unresolved: Set<string>): boolean {
  for (const depId of task.blockedBy) {
    if (!fs.existsSync(taskPath(depId))) return false;
    if (unresolved.has(depId)) return false;
  }
  return true;
}

function findAvailableTask(tasks: Task[]): Task | null {
  const unresolved = unresolvedTaskIds(tasks);
  for (const task of tasks) {
    if (task.status !== "pending" || task.owner) continue;
    if (depsSatisfied(task, unresolved)) return task;
  }
  return null;
}

function agentBusyTask(tasks: Task[], owner: string): Task | null {
  return tasks.find((t) => t.owner === owner && t.status === "in_progress") ?? null;
}

// ── claim / complete ─────────────────────────────────────────────────────

async function executeTaskClaim(taskId: string, owner: string): Promise<string> {
  const p = taskPath(taskId);
  if (!fs.existsSync(p)) throw new Error(`Task not found: ${taskId}`);

  let subject = "";
  let taskRef = "";
  await withFileLock(taskLockPath(taskId), async () => {
    const task = taskFromDict(JSON.parse(fs.readFileSync(p, "utf8")));
    if (task.status !== "pending") {
      throw new Error(`Task ${taskId} is ${task.status}, cannot claim`);
    }
    if (task.owner) {
      throw new Error(`Task ${taskId} already owned by ${task.owner}`);
    }
    const tasks = loadAllTasksRaw();
    if (!depsSatisfied(task, unresolvedTaskIds(tasks))) {
      const deps = task.blockedBy.filter(
        (d) => !fs.existsSync(taskPath(d)) || unresolvedTaskIds(tasks).has(d),
      );
      throw new Error(`Blocked by: ${deps.join(", ")}`);
    }
    task.owner = owner;
    task.status = "in_progress";
    fs.writeFileSync(p, JSON.stringify(task, null, 2));
    subject = task.subject;
    taskRef = task.id;
  });

  // 创建 worktree 隔离（非致命）
  const wt = createTaskWorktree(taskId);
  if (wt !== null) {
    setWorktreeOverride(wt);
    console.log(`  \x1b[36m[worktree] switched to ${wt}\x1b[0m`);
  }

  console.log(`  \x1b[36m[claim] ${subject} → in_progress (owner: ${owner})\x1b[0m`);
  return `Claimed ${taskRef} (${subject})`;
}

export async function claimTaskWithBusyCheck(
  owner: string,
  taskId?: string,
  options: { enforceBusy?: boolean } = {},
): Promise<string> {
  const enforceBusy = options.enforceBusy ?? true;
  ensureBlocksIndex();
  return withFileLock(path.join(tasksDir, ".lock"), async () => {
    const tasks = loadAllTasksRaw();

    if (enforceBusy) {
      const busy = agentBusyTask(tasks, owner);
      if (busy !== null) {
        return (
          `Agent '${owner}' is busy with ${busy.id} (${busy.subject}); ` +
          `complete it before claiming another task`
        );
      }
    }

    let chosenId: string;
    if (taskId !== undefined) {
      const target = tasks.find((t) => t.id === taskId);
      if (!target) return `Error: Task ${taskId} not found`;
      const unresolved = unresolvedTaskIds(tasks);
      if (target.status !== "pending") {
        return `Task ${taskId} is ${target.status}, cannot claim`;
      }
      if (target.owner) {
        return `Task ${taskId} already owned by ${target.owner}`;
      }
      if (!depsSatisfied(target, unresolved)) {
        const deps = target.blockedBy.filter(
          (d) => !fs.existsSync(taskPath(d)) || unresolved.has(d),
        );
        return `Blocked by: ${deps.join(", ")}`;
      }
      chosenId = taskId;
    } else {
      const available = findAvailableTask(tasks);
      if (!available) return "No unclaimed tasks available";
      chosenId = available.id;
    }

    return executeTaskClaim(chosenId, owner);
  });
}

export function tryClaimNextTask(owner: string): Promise<string> {
  return claimTaskWithBusyCheck(owner, undefined, { enforceBusy: true });
}

export function claimTask(
  taskId: string,
  owner = "agent",
  options: { enforceBusy?: boolean } = {},
): Promise<string> {
  return claimTaskWithBusyCheck(owner, taskId, {
    enforceBusy: options.enforceBusy ?? false,
  });
}

export async function completeTask(
  taskId: string,
  options: { owner?: string | null } = {},
): Promise<string> {
  const p = taskPath(taskId);
  if (!fs.existsSync(p)) throw new Error(`Task not found: ${taskId}`);

  let subject = "";
  let taskRef = "";
  let blockIds: string[] = [];
  await withFileLock(taskLockPath(taskId), async () => {
    const task = taskFromDict(JSON.parse(fs.readFileSync(p, "utf8")));
    if (task.status !== "in_progress") {
      throw new Error(`Task ${taskId} is ${task.status}, cannot complete`);
    }
    if (options.owner !== null && options.owner !== undefined && task.owner !== null && task.owner !== options.owner) {
      throw new Error(
        `Task ${taskId} is owned by ${task.owner}; only the owner can complete it`,
      );
    }
    task.status = "completed";
    fs.writeFileSync(p, JSON.stringify(task, null, 2));
    subject = task.subject;
    taskRef = task.id;
    blockIds = [...task.blocks];
  });

  // 移除 worktree（best-effort）并恢复工作目录
  removeTaskWorktree(taskId);
  setWorktreeOverride(null);

  const unblocked: string[] = [];
  for (const downId of blockIds) {
    if (!fs.existsSync(taskPath(downId))) continue;
    const downstream = loadTask(downId);
    if (downstream.status === "pending" && canStart(downId)) {
      unblocked.push(downstream.subject);
    }
  }
  console.log(`  \x1b[32m[complete] ${subject} ✓\x1b[0m`);
  let msg = `Completed ${taskRef} (${subject})`;
  if (unblocked.length > 0) {
    msg += `\nUnblocked: ${unblocked.join(", ")}`;
    console.log(`  \x1b[33m[unblocked] ${unblocked.join(", ")}\x1b[0m`);
  }
  return msg;
}

// ── 工具入口（供 LLM 调用）───────────────────────────────────────────────

export function runCreateTask(subject: string, description = "", blockedBy: string[] = []): string {
  try {
    const task = createTask(subject, description, blockedBy);
    const deps = blockedBy.length > 0 ? ` (blockedBy: ${blockedBy.join(", ")})` : "";
    console.log(`  \x1b[34m[create] ${task.subject}${deps}\x1b[0m`);
    return `Created ${task.id}: ${task.subject}${deps}`;
  } catch (e) {
    return `Error: ${String((e as Error).message)}`;
  }
}

export function runListTasks(statusFilter = "all"): string {
  const tasks = listTasks();
  const filtered = statusFilter !== "all" ? tasks.filter((t) => t.status === statusFilter) : tasks;
  if (filtered.length === 0) return "No tasks. Use create_task to add some.";
  const lines = filtered.map((t) => {
    const icon = { pending: "○", in_progress: "●", completed: "✓" }[t.status] ?? "?";
    const deps = t.blockedBy.length > 0 ? ` (blockedBy: ${t.blockedBy.join(", ")})` : "";
    const blocks = t.blocks.length > 0 ? ` (blocks: ${t.blocks.join(", ")})` : "";
    const owner = t.owner ? ` [${t.owner}]` : "";
    return `  ${icon} ${t.id}: ${t.subject} [${t.status}]${owner}${deps}${blocks}`;
  });
  return lines.join("\n");
}

export function runGetTask(taskId: string): string {
  try {
    return getTask(taskId);
  } catch {
    return `Error: Task ${taskId} not found`;
  }
}

export function runClaimTask(taskId: string, owner?: string): Promise<string> {
  const effOwner = owner ?? "agent";
  return claimTask(taskId, effOwner);
}

export function runCompleteTask(taskId: string): Promise<string> {
  return completeTask(taskId);
}

/** workdir 覆盖状态下的有效目录（供外部查询） */
export function currentWorkdir(): string {
  return getWorkdir();
}
