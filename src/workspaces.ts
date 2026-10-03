import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { repositoryInfo, repositoryGit, withRepositoryLock } from "./repository-lock.ts";
import { getWorkdir, getWorkspaceBinding, setWorkspaceBinding } from "./workdir.ts";
import { getAgentContext, isReadOnlyRole } from "./teammates/context.ts";
import { writeFileAtomic } from "./atomic-write.ts";
import { recoverFileTransactions } from "./file-transactions.ts";

export interface WorkspaceBinding {
  id: string; repositoryId: string; repositoryRoot: string; taskId: string; agentId: string;
  worktreePath: string; branch: string; baseSha: string; generation: string;
  status: "active" | "review" | "closed"; ownerPid: number; ownerStart: string;
  parentPath?: string; recordPath: string;
  taskRecordPath?: string;
}

function processStart(pid: number): string {
  try { return fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ")[19]; } catch { return "unknown"; }
}
function ownerAlive(b: WorkspaceBinding): boolean {
  try { process.kill(b.ownerPid, 0); return b.ownerStart === "unknown" || processStart(b.ownerPid) === b.ownerStart; } catch { return false; }
}
export function workspaceActor(): string {
  const ctx = getAgentContext();
  return ctx.agentId ?? `${ctx.teamName ?? "local"}:${ctx.agentName}`;
}
function recordFor(root: string, owner: string): string {
  return path.join(repositoryInfo(root).root, ".agent", "workspaces", `${createHash("sha256").update(owner).digest("hex")}.json`);
}
export function readWorkspaceRecord(p: string): WorkspaceBinding | undefined {
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) as WorkspaceBinding : undefined;
}
export function findAgentWorkspace(root: string, owner: string): WorkspaceBinding | undefined {
  return readWorkspaceRecord(recordFor(root, owner));
}
export function validateWorkspace(binding: WorkspaceBinding, requireActive = true): WorkspaceBinding {
  const current = readWorkspaceRecord(binding.recordPath);
  if (!current || current.id !== binding.id || current.generation !== binding.generation || (requireActive && current.status !== "active")) throw new Error("Workspace lease is stale or no longer writable");
  if (!fs.existsSync(current.worktreePath) || fs.realpathSync(current.worktreePath) !== current.worktreePath) throw new Error("Workspace path is missing or redirected");
  const repo = repositoryInfo(current.worktreePath);
  if (!repo.git || repo.id !== current.repositoryId || repositoryGit(current.worktreePath, ["symbolic-ref", "--short", "HEAD"]) !== current.branch || fs.realpathSync(repositoryGit(current.worktreePath, ["rev-parse", "--show-toplevel"])) !== current.worktreePath) throw new Error("Workspace repository or branch mismatch");
  return current;
}
export function requireWritableWorkspace(): WorkspaceBinding | undefined {
  const ctx = getAgentContext(), binding = getWorkspaceBinding();
  const required = ctx.role === "worker" || ctx.role === "subagent" || ctx.role === "teammate" || process.env.CLAUDE_PI_ISOLATION === "required";
  if (!binding) { if (required) throw new Error("Write requires an isolated workspace; claim a task or delegate to a worker"); return undefined; }
  const current = validateWorkspace(binding);
  if (current.ownerPid !== process.pid || current.ownerStart !== processStart(process.pid)) throw new Error("Workspace is owned by another cpi process; restore it before writing");
  if (current.taskRecordPath) {
    const task = JSON.parse(fs.readFileSync(current.taskRecordPath, "utf8"));
    if (task.status !== "in_progress" || task.owner !== current.agentId || task.binding?.id !== current.id) throw new Error("Task is no longer assigned for writing");
  }
  if (ctx.agentId && current.agentId !== workspaceActor()) throw new Error("Workspace belongs to another agent");
  if (fs.realpathSync(getWorkdir()) !== current.worktreePath) throw new Error("Workspace directory binding mismatch");
  return current;
}

export function assertWorkspaceQuiescent(root: string): void {
  const dir = path.join(root, ".agent", "processes");
  if (!fs.existsSync(dir)) return;
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith(".json"))) {
    const record = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    if (record.status === "starting" || record.status === "running") throw new Error(`Workspace still has a running or unverified process: ${record.id}. Wait or cancel it before delivering work.`);
  }
}
export function assertWorkspaceDeliverable(root: string): void {
  assertWorkspaceQuiescent(root);
  const dir = path.join(repositoryInfo(root).root, ".agent", "workspaces", "records");
  if (!fs.existsSync(dir)) return;
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith(".json"))) {
    const binding = readWorkspaceRecord(path.join(dir, file));
    if (binding?.status === "active" && binding.parentPath === fs.realpathSync(root)) throw new Error(`Workspace has an unfinished child worker: ${binding.taskId}`);
  }
}

export function registerWorkspace(root: string, wt: string, taskId: string, owner: string, baseSha: string, branch: string, parentPath?: string, activate = true): WorkspaceBinding {
  const info = repositoryInfo(root), ownerPath = recordFor(root, owner), id = randomUUID();
  const recordPath = path.join(path.dirname(ownerPath), "records", `${id}.json`);
  const previous = readWorkspaceRecord(ownerPath);
  if (previous?.status === "active") throw new Error(`Agent already owns workspace ${previous.taskId}`);
  const binding: WorkspaceBinding = { id, repositoryId: info.id, repositoryRoot: info.root, taskId, agentId: owner, worktreePath: fs.realpathSync(wt), branch, baseSha, generation: randomUUID(), status: "active", ownerPid: process.pid, ownerStart: processStart(process.pid), recordPath, ...(parentPath ? { parentPath } : {}) };
  fs.mkdirSync(path.dirname(recordPath), { recursive: true, mode: 0o700 });
  writeFileAtomic(recordPath, JSON.stringify(binding));
  writeFileAtomic(ownerPath, JSON.stringify(binding));
  validateWorkspace(binding);
  if (activate) setWorkspaceBinding(binding);
  return binding;
}
export function finishWorkspace(binding: WorkspaceBinding, status: "review" | "closed"): void {
  const current = validateWorkspace(binding, false);
  assertWorkspaceDeliverable(current.worktreePath);
  current.status = status; writeFileAtomic(current.recordPath, JSON.stringify(current));
  const ownerPath = recordFor(current.repositoryRoot, current.agentId);
  if (readWorkspaceRecord(ownerPath)?.id === current.id) writeFileAtomic(ownerPath, JSON.stringify(current));
  if (getWorkspaceBinding()?.id === binding.id) setWorkspaceBinding();
}
export function attachWorkspaceTask(binding: WorkspaceBinding, taskRecordPath: string): void {
  binding.taskRecordPath = taskRecordPath;
  writeFileAtomic(binding.recordPath, JSON.stringify(binding));
  writeFileAtomic(recordFor(binding.repositoryRoot, binding.agentId), JSON.stringify(binding));
}
export async function restoreAgentWorkspace(root = getWorkdir()): Promise<void> {
  await withRepositoryLock(root, () => {
    recoverFileTransactions(root);
    const binding = getWorkspaceBinding();
    if (binding) { setWorkspaceBinding(validateWorkspace(binding)); recoverFileTransactions(binding.worktreePath); return; }
    const current = readWorkspaceRecord(recordFor(root, workspaceActor()));
    if (!current || current.status !== "active") return;
    if (current.ownerPid !== process.pid || current.ownerStart !== processStart(process.pid)) {
      if (ownerAlive(current)) throw new Error("Workspace is owned by another live cpi process");
      assertWorkspaceQuiescent(current.worktreePath);
      current.ownerPid = process.pid; current.ownerStart = processStart(process.pid); current.generation = randomUUID();
      writeFileAtomic(current.recordPath, JSON.stringify(current));
      writeFileAtomic(recordFor(root, workspaceActor()), JSON.stringify(current));
    }
    if (current.taskRecordPath) {
      const task = JSON.parse(fs.readFileSync(current.taskRecordPath, "utf8"));
      if (task.owner !== current.agentId || !["preparing", "in_progress"].includes(task.status) || (task.binding && task.binding.id !== current.id)) throw new Error("Task ownership changed while restoring");
      task.binding = current; task.status = "in_progress"; delete task.preparingPid;
      writeFileAtomic(current.taskRecordPath, JSON.stringify(task));
    }
    setWorkspaceBinding(validateWorkspace(current)); recoverFileTransactions(current.worktreePath);
  });
}

/** Snapshot current bytes using a temporary index. Never touch the user's index or HEAD. */
export async function createWorkerWorkspace(parentPath: string, owner: string): Promise<WorkspaceBinding> {
  return withRepositoryLock(parentPath, async () => {
    const info = repositoryInfo(parentPath);
    if (!info.git) throw new Error("Worker isolation requires a Git repository with a committed HEAD");
    assertWorkspaceQuiescent(parentPath); recoverFileTransactions(parentPath);
    const taskId = `worker-${randomUUID()}`, branch = `agent/${taskId}`;
    const dir = path.join(info.root, ".agent", "worktrees"); fs.mkdirSync(dir, { recursive: true });
    const index = path.join(dir, `${taskId}.index`), wt = path.join(dir, taskId);
    const env = { GIT_INDEX_FILE: index, GIT_AUTHOR_NAME: "cpi snapshot", GIT_AUTHOR_EMAIL: "snapshot@cpi.local", GIT_COMMITTER_NAME: "cpi snapshot", GIT_COMMITTER_EMAIL: "snapshot@cpi.local" };
    let added = false;
    try {
      const head = repositoryGit(parentPath, ["rev-parse", "HEAD"]);
      repositoryGit(parentPath, ["read-tree", head], env);
      const raw = (args: string[]) => execFileSync("git", args, { cwd: parentPath, encoding: "utf8", env: { ...process.env, ...env } });
      const original = raw(["ls-tree", "-r", "--name-only", "-z", head]).split("\0").filter(Boolean);
      // Read the real index to include staged new files, plus non-ignored untracked files.
      const working = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: parentPath, encoding: "utf8" }).split("\0").filter(Boolean);
      const hashes = new Map<string, { hash: string; mode: number }>();
      let n = 0;
      for (const file of new Set([...original, ...working])) {
        const full = path.join(parentPath, file);
        const privateFile = /^(?:\.agent|\.git|\.task_outputs|\.transcripts|node_modules)(?:\/|$)/.test(file) || /(?:^|\/)(?:\.env(?:\..*)?|auth\.json|credentials)$/.test(file);
        if (privateFile || !fs.existsSync(full)) {
          repositoryGit(parentPath, ["update-index", "--force-remove", "--", file], env);
          if (!privateFile) hashes.set(file, { hash: "missing", mode: 0 });
          continue;
        }
        if (!fs.lstatSync(full).isFile()) throw new Error(`Snapshot requires a regular file: ${file}`);
        const object = repositoryGit(parentPath, ["hash-object", "-w", "--no-filters", "--", file]);
        hashes.set(file, { hash: object, mode: fs.statSync(full).mode & 0o777 });
        const mode = fs.statSync(full).mode & 0o111 ? "100755" : "100644";
        repositoryGit(parentPath, ["update-index", "--add", "--cacheinfo", `${mode},${object},${file}`], env);
        if (++n % 20 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
      for (const [file, state] of hashes) {
        const full = path.join(parentPath, file);
        const hash = fs.existsSync(full) ? repositoryGit(parentPath, ["hash-object", "--no-filters", "--", file]) : "missing";
        const mode = fs.existsSync(full) ? fs.statSync(full).mode & 0o777 : 0;
        if (hash !== state.hash || mode !== state.mode) throw new Error("Parent workspace changed while snapshotting");
      }
      const tree = repositoryGit(parentPath, ["write-tree"], env);
      const baseSha = repositoryGit(parentPath, ["commit-tree", tree, "-p", head, "-m", "cpi private worker baseline"], env);
      repositoryGit(info.root, ["worktree", "add", "-b", branch, wt, baseSha]); added = true;
      return registerWorkspace(info.root, wt, taskId, owner, baseSha, branch, fs.realpathSync(parentPath), false);
    } catch (e) {
      if (added) { try { repositoryGit(info.root, ["worktree", "remove", wt]); repositoryGit(info.root, ["branch", "-D", branch]); } catch { /* Preserve anything that became dirty. */ } }
      throw e;
    } finally { fs.rmSync(index, { force: true }); fs.rmSync(`${index}.lock`, { force: true }); }
  });
}

export async function registerWorkspaceProcess(root: string): Promise<string | undefined> {
  const binding = getWorkspaceBinding();
  if (!binding || isReadOnlyRole(getAgentContext().role)) return undefined;
  return withRepositoryLock(root, () => {
    requireWritableWorkspace();
    const dir = path.join(root, ".agent", "processes"); fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, `${randomUUID()}.json`);
    writeFileAtomic(p, JSON.stringify({ id: path.basename(p), workspaceId: binding.id, generation: binding.generation, ownerPid: process.pid, ownerStart: processStart(process.pid), status: "starting" }));
    return p;
  });
}
export function updateWorkspaceProcess(p: string | undefined, status: string, childPid?: number): void {
  if (!p) return;
  const record = JSON.parse(fs.readFileSync(p, "utf8"));
  writeFileAtomic(p, JSON.stringify({ ...record, status, ...(childPid ? { childPid } : {}) }));
}
