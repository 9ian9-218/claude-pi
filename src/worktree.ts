/**
 * worktree.ts — Git worktree 隔离（对齐 src/worktree.py）
 *
 * claim 任务 → 创建 .agent/worktrees/<task_id>/（分支 agent/task-<task_id>）；
 * complete → 移除 worktree 与分支。git 不可用或失败时静默降级（非致命）。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { AGENT_ROOT } from "./config.ts";
import { getWorkdir, runWithWorkdir } from "./workdir.ts";
import { safePath } from "./tools/path.ts";
import { fileHash, saveFileCheckpoint, restoreFileCheckpoint } from "./checkpoints.ts";
import { createHash } from "node:crypto";
import { writeFileAtomic } from "./atomic-write.ts";

let gitRoot: string = AGENT_ROOT;

export function setGitRoot(root: string): void {
  gitRoot = root;
}

function worktreesDir(): string {
  // 随 gitRoot 派生（测试注入临时仓库时 worktree 落在仓库内）
  return path.join(gitRoot, ".agent", "worktrees");
}

export function ensureWorktreesDir(): void {
  fs.mkdirSync(worktreesDir(), { recursive: true });
}

function git(...args: string[]): string {
  const result = execFileSync("git", args, {
    cwd: gitRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
  return result.trim();
}

export function isGitAvailable(): boolean {
  try {
    git("rev-parse", "--git-dir");
    return true;
  } catch {
    return false;
  }
}


/** 分支名：agent/task-<id>（ADR：与 .agent/ 数据根保持一致） */
export function taskBranchName(taskId: string): string {
  return `agent/task-${taskId}`;
}

export function taskWorktreePath(taskId: string): string {
  if (!/^task_\d+$/.test(taskId)) throw new Error("Invalid task id");
  return path.join(worktreesDir(), taskId);
}

/** 创建任务 worktree；失败返回 null（非致命） */
export function createTaskWorktree(taskId: string): string | null {
  if (!/^task_\d+$/.test(taskId)) throw new Error("Invalid task id");
  if (!isGitAvailable()) return null;

  ensureWorktreesDir();
  const wtPath = taskWorktreePath(taskId);
  if (fs.existsSync(wtPath)) return wtPath;

  const branch = taskBranchName(taskId);
  let createdBranch = false;

  // 1. 从 HEAD 创建跟踪分支（best-effort）
  try {
    git("branch", "--track", branch, "HEAD");
    createdBranch = true;
  } catch {
    // 分支可能已存在
  }

  // 2. 创建 worktree
  try {
    git("worktree", "add", wtPath, branch);
  } catch (e) {
    try {
      if (createdBranch) git("branch", "-d", branch);
    } catch {
      // 忽略
    }
    console.log(
      `  \x1b[33m[worktree] warning: could not create worktree for ${taskId}: ${String(e)}\x1b[0m`,
    );
    return null;
  }

  console.log(`  \x1b[36m[worktree] created at ${wtPath} (branch: ${branch})\x1b[0m`);
  return wtPath;
}

export interface TaskArtifact {
  directory: string;
  worktree: string;
  baseSha: string;
  headSha: string;
  files: Array<{ path: string; hash: string | null; baseHash: string | null; mode?: number; executable?: boolean; baseExecutable?: boolean }>;
}

export function preserveTaskArtifact(taskId: string): TaskArtifact | null {
  if (!isGitAvailable()) return null;
  const worktree = taskWorktreePath(taskId);
  if (!fs.existsSync(worktree)) return null;
  const run = (...args: string[]) => execFileSync("git", args, { cwd: worktree, encoding: "utf8" });
  const baseSha = git("merge-base", "HEAD", taskBranchName(taskId));
  const headSha = run("rev-parse", "HEAD").trim();
  const changed = run("diff", "--name-only", "-z", baseSha).split("\0").filter(Boolean);
  const untracked = run("ls-files", "--others", "--exclude-standard", "-z").split("\0").filter(p => p && !p.startsWith(".agent/") && !p.startsWith(".task_outputs/"));
  const paths = [...new Set([...changed, ...untracked])];
  const directory = path.join(gitRoot, ".agent", "artifacts", taskId);
  fs.mkdirSync(directory, { recursive: true });
  const files = paths.map(p => {
    let baseHash: string | null = null;
    let baseExecutable = false;
    try { baseExecutable = run("ls-tree", baseSha, "--", p).startsWith("100755 "); } catch { /* New file. */ }
    try { baseHash = fileHash(execFileSync("git", ["show", `${baseSha}:${p}`], { cwd: worktree, stdio: ["ignore", "pipe", "pipe"] })); } catch { /* New file. */ }
    const full = path.join(worktree, p);
    if (!fs.existsSync(full)) return { path: p, hash: null, baseHash, baseExecutable };
    if (!fs.lstatSync(full).isFile()) throw new Error(`Unsupported artifact file: ${p}`);
    const data = fs.readFileSync(full);
    const dest = path.join(directory, "files", p);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    writeFileAtomic(dest, data);
    return { path: p, hash: fileHash(data), baseHash, mode: fs.statSync(full).mode & 0o777, executable: Boolean(fs.statSync(full).mode & 0o111), baseExecutable };
  });
  writeFileAtomic(path.join(directory, "changes.patch"), run("diff", "--binary", baseSha));
  const artifact = { directory, worktree, baseSha, headSha, files };
  writeFileAtomic(path.join(directory, "manifest.json"), JSON.stringify(artifact, null, 2));
  return artifact;
}

/** Explicit review/integration step. Refuse overwriting main-workspace changes. */
export function integrateTaskArtifact(artifact: TaskArtifact): void {
  runWithWorkdir(gitRoot, () => {
    const staged = artifact.files.map(file => {
      const target = safePath(file.path);
      if (fs.existsSync(target) && !fs.lstatSync(target).isFile()) throw new Error(`Integration conflict: ${file.path} is not a regular file`);
      const current = fs.existsSync(target) ? fileHash(fs.readFileSync(target)) : null;
      const executable = fs.existsSync(target) ? Boolean(fs.statSync(target).mode & 0o111) : false;
      const integrated = current === file.hash && (file.hash === null || file.executable === undefined || executable === file.executable);
      const matchesBase = current === file.baseHash && (file.baseHash === null || file.baseExecutable === undefined || executable === file.baseExecutable);
      if (!integrated && !matchesBase) throw new Error(`Integration conflict: ${file.path} changed in the main workspace`);
      const data = file.hash === null ? null : fs.readFileSync(safePath(path.join(artifact.directory, "files", file.path)));
      if (data && fileHash(data) !== file.hash) throw new Error(`Artifact integrity check failed: ${file.path}`);
      return { file, target, current, data, integrated };
    });
    const checkpoints: string[] = [];
    try {
      for (const { file, target, current, data, integrated } of staged) {
        if (integrated) continue;
        if ((fs.existsSync(target) ? fileHash(fs.readFileSync(target)) : null) !== current) throw new Error(`Integration conflict: ${file.path} changed during integration`);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const id = saveFileCheckpoint(target, data);
        if (data === null) fs.unlinkSync(target); else { writeFileAtomic(target, data); if (file.mode !== undefined) fs.chmodSync(target, file.mode); }
        checkpoints.push(id);
      }
    } catch (e) {
      const conflicts: string[] = [];
      for (const id of checkpoints.reverse()) try { restoreFileCheckpoint(id); } catch (rollback) { conflicts.push(String(rollback)); }
      throw new Error(`${String(e)}${conflicts.length ? `; rollback conflicts: ${conflicts.join("; ")}` : ""}`);
    }
  });
}

export function artifactIntegrated(artifact: TaskArtifact): boolean {
  return artifact.files.every(file => {
    const p = path.join(gitRoot, file.path);
    if (file.hash === null) return !fs.existsSync(p);
    return fs.existsSync(p) && fs.lstatSync(p).isFile() && createHash("sha256").update(fs.readFileSync(p)).digest("hex") === file.hash && (file.executable === undefined || Boolean(fs.statSync(p).mode & 0o111) === file.executable);
  });
}

/** Never force-delete dirty or unmerged work. */
export function removeTaskWorktree(taskId: string): boolean {
  if (!isGitAvailable()) return true;

  const wtPath = taskWorktreePath(taskId);
  const branch = taskBranchName(taskId);

  if (fs.existsSync(wtPath)) {
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: wtPath, encoding: "utf8" });
    if (status.trim()) return false;
    try { git("merge-base", "--is-ancestor", branch, "HEAD"); } catch { return false; }
    try {
      git("worktree", "remove", wtPath);
    } catch {
      return false;
    }
  }
  try {
    git("worktree", "prune");
  } catch {
    // 忽略
  }
  try {
    git("branch", "-d", branch);
  } catch {
    // 忽略
  }
  return true;
}

export function listTaskWorktrees(): string[] {
  ensureWorktreesDir();
  return fs
    .readdirSync(worktreesDir(), { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => d.name)
    .sort();
}

export function getCurrentWorktreeTaskId(): string | null {
  // 基于当前有效 workdir（claim 后 workdir=worktree）；
  // 修正 Python 版固定 git cwd 导致的恒 None 失效
  const wd = getWorkdir();
  const wtResolved = path.resolve(worktreesDir());
  if (wd.startsWith(wtResolved + path.sep)) {
    return path.basename(wd);
  }
  return null;
}
