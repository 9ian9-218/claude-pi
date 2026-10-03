/**
 * tasks.ts — 持久化任务看板（对齐 src/tasks.py）
 *
 * .agent/tasks/task_<n>.json + highwatermark；blockedBy 依赖图 + blocks 反向索引；
 * claim → worktree 隔离 + workdir 切换；complete → 清理 + 恢复 + 解除下游阻塞。
 */
import fs from "node:fs";
import { writeFileAtomic } from "./atomic-write.ts";
import path from "node:path";
import { AGENT_ROOT, resolveAgentDirs } from "./config.ts";
import { withFileLock } from "./file-lock.ts";
import { createTaskWorktree, removeTaskWorktree, preserveTaskArtifact, artifactIntegrated, integrateTaskArtifact, getGitRoot, taskBranchName, taskWorktreePath, type TaskArtifact } from "./worktree.ts";
import { withRepositoryLock, repositoryGit, repositoryInfo } from "./repository-lock.ts";
import { registerWorkspace, attachWorkspaceTask, finishWorkspace, readWorkspaceRecord, findAgentWorkspace, assertWorkspaceQuiescent, assertWorkspaceDeliverable, validateWorkspace, workspaceActor, type WorkspaceBinding } from "./workspaces.ts";

// 测试可注入；默认 .agent/tasks
let tasksDir: string = resolveAgentDirs(repositoryInfo(AGENT_ROOT).root).tasksDir;

export function setTasksDir(dir: string): void {
  tasksDir = dir;
}

export interface Task {
  id: string;
  subject: string;
  description: string;
  status: "pending" | "preparing" | "in_progress" | "ready_for_review" | "completed";
  artifact?: TaskArtifact;
  binding?: WorkspaceBinding;
  baseSha?: string;
  preparingPid?: number;
  owner: string | null;
  blockedBy: string[];
  blocks: string[];
}

function highwatermarkFile(): string {
  return path.join(tasksDir, ".highwatermark");
}

function taskPath(taskId: string): string {
  if (!/^task_\d+$/.test(taskId)) throw new Error("Invalid task id");
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
  writeFileAtomic(highwatermarkFile(), `${value}\n`);
}

function maxIdFromTaskFiles(): number {
  let maxId = 0;
  if (!fs.existsSync(tasksDir)) return maxId;
  for (const f of fs.readdirSync(tasksDir).filter((f) => f.startsWith("task_") && f.endsWith(".json"))) {
    const num = parseTaskNum(path.basename(f, ".json"));
    if (num !== null) maxId = Math.max(maxId, num);
  }
  return maxId;
}

export async function allocateTaskId(): Promise<string> {
  return withFileLock(path.join(tasksDir, ".lock"), () => {
    const nextId = Math.max(readHighwatermark(), maxIdFromTaskFiles()) + 1;
    writeHighwatermark(nextId);
    return `task_${nextId}`;
  });
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
    ...(data.artifact ? { artifact: data.artifact as TaskArtifact } : {}),
    ...(data.binding ? { binding: data.binding as WorkspaceBinding } : {}),
    ...(data.baseSha ? { baseSha: String(data.baseSha) } : {}),
    ...(data.preparingPid ? { preparingPid: Number(data.preparingPid) } : {}),
  };
}

// blocks 反向索引（每进程首次访问同步一次，对齐 Python _blocks_index_synced）


export function resetBlocksIndex(): void {

}

// Reads never rewrite task records. Derive reverse dependencies from the graph.
export function ensureBlocksIndex(): void {}

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

export async function createTask(
  subject: string,
  description = "",
  blockedBy: string[] = [],
): Promise<Task> {
  return withFileLock(path.join(tasksDir, ".lock"), () => {
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
  return task;
  });
}

export function saveTask(task: Task): void {
  fs.mkdirSync(tasksDir, { recursive: true });
  writeFileAtomic(taskPath(task.id), JSON.stringify(task, null, 2));
}

export function loadTask(taskId: string): Task {
  ensureBlocksIndex();
  const task = taskFromDict(JSON.parse(fs.readFileSync(taskPath(taskId), "utf8")));
  task.blocks = loadAllTasksRaw().filter(t => t.blockedBy.includes(taskId)).map(t => t.id);
  return task;
}

export function listTasks(): Task[] {
  ensureBlocksIndex();
  if (!fs.existsSync(tasksDir)) return [];
  const tasks = fs
    .readdirSync(tasksDir)
    .filter((f) => f.startsWith("task_") && f.endsWith(".json"))
    .map((f) => taskFromDict(JSON.parse(fs.readFileSync(path.join(tasksDir, f), "utf8"))));
  tasks.sort((a, b) => (parseTaskNum(a.id) ?? 0) - (parseTaskNum(b.id) ?? 0));
  for (const task of tasks) task.blocks = tasks.filter(t => t.blockedBy.includes(task.id)).map(t => t.id);
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
  return withFileLock(taskLockPath(taskId), () => {
    const task = loadTask(taskId);
    if (task.status !== "pending" || task.owner) throw new Error(`Task ${taskId} cannot be claimed`);
    task.status = "preparing"; task.owner = owner; task.preparingPid = process.pid;
    task.baseSha = repositoryGit(fs.existsSync(taskWorktreePath(taskId)) ? taskWorktreePath(taskId) : getGitRoot(), ["rev-parse", "HEAD"]);
    saveTask(task);
    try {
      const wt = createTaskWorktree(taskId);
      if (!wt) throw new Error("Task worktree creation failed");
      task.binding = registerWorkspace(getGitRoot(), wt, taskId, owner, task.baseSha, taskBranchName(taskId));
      attachWorkspaceTask(task.binding, taskPath(taskId));
      task.status = "in_progress"; delete task.preparingPid; saveTask(task);
      return `Claimed ${task.id} (${task.subject})`;
    } catch (error) {
      if (task.binding) finishWorkspace(task.binding, "closed");
      task.status = "pending"; task.owner = null; delete task.binding; delete task.preparingPid;
      saveTask(task); throw error;
    }
  });
}

export async function claimTaskWithBusyCheck(
  owner: string,
  taskId?: string,
  options: { enforceBusy?: boolean } = {},
): Promise<string> {
  const enforceBusy = options.enforceBusy ?? true;
  ensureBlocksIndex();
  return withRepositoryLock(getGitRoot(), () => withFileLock(path.join(tasksDir, ".lock"), async () => {
    // A crash before publishing the lease must not leave an unrecoverable claim.
    for (const task of loadAllTasksRaw().filter(t => t.status === "preparing")) {
      if (!task.preparingPid) throw new Error(`Cannot verify interrupted preparation: ${task.id}`);
      try { process.kill(task.preparingPid, 0); continue; } catch { /* Owner has exited. */ }
      const binding = task.owner ? findAgentWorkspace(getGitRoot(), task.owner) : undefined;
      if (binding?.status === "active" && binding.taskId === task.id) {
        task.binding = validateWorkspace(binding); attachWorkspaceTask(task.binding, taskPath(task.id)); task.status = "in_progress";
      } else {
        const wt = taskWorktreePath(task.id);
        if (fs.existsSync(wt)) {
          createTaskWorktree(task.id); assertWorkspaceQuiescent(wt);
          const changed = repositoryGit(wt, ["diff", "--name-only", "HEAD"]);
          const untracked = repositoryGit(wt, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(p => p && !/^(?:\.agent|\.task_outputs|\.transcripts)(?:\/|$)/.test(p));
          if (changed || untracked.length) throw new Error(`Interrupted preparation has changes to review: ${wt}`);
        }
        task.status = "pending"; task.owner = null;
      }
      delete task.preparingPid; saveTask(task);
    }
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
  }));
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
  await withRepositoryLock(getGitRoot(), () => withFileLock(path.join(tasksDir, ".lock"), () => withFileLock(taskLockPath(taskId), async () => {
    const task = taskFromDict(JSON.parse(fs.readFileSync(p, "utf8")));
    if (task.status !== "in_progress" && task.status !== "ready_for_review") {
      throw new Error(`Task ${taskId} is ${task.status}, cannot complete`);
    }
    if (options.owner !== null && options.owner !== undefined && task.owner !== null && task.owner !== options.owner) {
      throw new Error(
        `Task ${taskId} is owned by ${task.owner}; only the owner can complete it`,
      );
    }
    if (task.binding) {
      const current = readWorkspaceRecord(task.binding.recordPath);
      if (!current || current.id !== task.binding.id) throw new Error("Task workspace record changed");
      task.binding = validateWorkspace(current, false); assertWorkspaceDeliverable(task.binding.worktreePath);
    }
    const artifact = preserveTaskArtifact(taskId, task.baseSha) ?? task.artifact;
    if (artifact) task.artifact = artifact;
    task.status = artifact && artifact.files.length > 0 && !artifactIntegrated(artifact) ? "ready_for_review" : "completed";
    subject = task.subject;
    taskRef = task.id;
    blockIds = loadAllTasksRaw().filter(t => t.blockedBy.includes(taskId)).map(t => t.id);
    if (task.binding) finishWorkspace(task.binding, task.status === "completed" ? "closed" : "review");
    writeFileAtomic(p, JSON.stringify(task, null, 2));
  })));

  const delivered = loadTask(taskId);
  if (delivered.status === "ready_for_review") {
    return `Ready for review ${taskRef} (${subject}). Worktree retained at ${delivered.artifact?.worktree}; artifacts: ${delivered.artifact?.directory}. Integrate the reviewed files, then call complete_task again. Dependencies remain blocked until integration.`;
  }

  // 移除 worktree（best-effort）并恢复工作目录
  await withRepositoryLock(getGitRoot(), () => removeTaskWorktree(taskId));

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

export async function integrateTask(taskId: string): Promise<string> {
  return withRepositoryLock(getGitRoot(), async () => {
    await withFileLock(path.join(tasksDir, ".lock"), () => withFileLock(taskLockPath(taskId), async () => {
      const task = loadTask(taskId);
      if (task.status !== "ready_for_review" || !task.artifact) throw new Error("Task must be ready_for_review with saved artifacts");
      await integrateTaskArtifact(task.artifact);
    }));
    return completeTask(taskId);
  });
}

// ── 工具入口（供 LLM 调用）───────────────────────────────────────────────

export async function runCreateTask(subject: string, description = "", blockedBy: string[] = []): Promise<string> {
  try {
    const task = await createTask(subject, description, blockedBy);
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
    const icon = { pending: "○", preparing: "◌", in_progress: "●", ready_for_review: "◇", completed: "✓" }[t.status] ?? "?";
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
  const effOwner = owner ?? workspaceActor();
  return claimTask(taskId, effOwner);
}

export function runCompleteTask(taskId: string): Promise<string> {
  return completeTask(taskId, { owner: workspaceActor() });
}
