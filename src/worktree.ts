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
import { getWorkdir } from "./workdir.ts";

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

export function isGitClean(): boolean {
  try {
    return git("status", "--porcelain").length === 0;
  } catch {
    return false;
  }
}

/** 分支名：agent/task-<id>（ADR：与 .agent/ 数据根保持一致） */
export function taskBranchName(taskId: string): string {
  return `agent/task-${taskId}`;
}

export function taskWorktreePath(taskId: string): string {
  return path.join(worktreesDir(), taskId);
}

/** 创建任务 worktree；失败返回 null（非致命） */
export function createTaskWorktree(taskId: string): string | null {
  if (!isGitAvailable()) return null;

  ensureWorktreesDir();
  const wtPath = taskWorktreePath(taskId);
  if (fs.existsSync(wtPath)) return wtPath;

  const branch = taskBranchName(taskId);

  // 1. 从 HEAD 创建跟踪分支（best-effort）
  try {
    git("branch", "--track", branch, "HEAD");
  } catch {
    // 分支可能已存在
  }

  // 2. 创建 worktree
  try {
    git("worktree", "add", wtPath, branch);
  } catch (e) {
    try {
      git("branch", "-D", branch);
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

/** 移除 worktree 与分支（best-effort，绝不抛出） */
export function removeTaskWorktree(taskId: string): void {
  if (!isGitAvailable()) return;

  const wtPath = taskWorktreePath(taskId);
  const branch = taskBranchName(taskId);

  if (fs.existsSync(wtPath)) {
    try {
      git("worktree", "remove", wtPath);
    } catch {
      try {
        git("worktree", "remove", "--force", wtPath);
      } catch {
        // 忽略
      }
    }
  }
  try {
    git("worktree", "prune");
  } catch {
    // 忽略
  }
  try {
    git("branch", "-D", branch);
  } catch {
    // 忽略
  }
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
