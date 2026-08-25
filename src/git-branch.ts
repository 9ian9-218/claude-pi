/**
 * git-branch.ts — footer 第 1 行 git 分支（对齐 pi footer `pwd (branch)`）
 *
 * TTL 缓存（默认 60s）：render 是热路径，不每次跑 git 子进程；
 * 失败（非 git 仓库/git 缺失）→ null 静默降级（不显示分支）。
 * 同步 execFileSync 与 worktree.ts 先例一致；调用方为 render 路径，
 * 缓存命中时零开销。
 */
import { execFileSync } from "node:child_process";

const TTL_MS = 60_000;
const cache = new Map<string, { branch: string | null; at: number }>();

/** 当前 git 分支名；非仓库/失败/超时 → null */
export function getGitBranch(cwd: string): string | null {
  const hit = cache.get(cwd);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.branch;

  let branch: string | null = null;
  try {
    branch =
      execFileSync("git", ["branch", "--show-current"], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 3_000,
      }).trim() || null;
  } catch {
    branch = null;
  }
  cache.set(cwd, { branch, at: Date.now() });
  return branch;
}

/** 测试用：清缓存 */
export function resetGitBranchCache(): void {
  cache.clear();
}
