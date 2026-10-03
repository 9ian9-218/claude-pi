import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { withFileLock } from "./file-lock.ts";

export function repositoryInfo(cwd: string): { root: string; commonDir: string; id: string; git: boolean } {
  const real = fs.realpathSync(cwd);
  try {
    const commonDir = fs.realpathSync(execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: real, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 }).trim());
    const root = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: real, encoding: "utf8", timeout: 5000 }).split("\n")[0].slice("worktree ".length);
    return { root: fs.realpathSync(root), commonDir, id: createHash("sha256").update(commonDir).digest("hex"), git: true };
  } catch {
    return { root: real, commonDir: path.join(real, ".agent"), id: createHash("sha256").update(real).digest("hex"), git: false };
  }
}

const held = new AsyncLocalStorage<Set<string>>();
/** All cpi mutations in one repository share this lock, including linked worktrees. */
export async function withRepositoryLock<T>(cwd: string, fn: () => T | Promise<T>): Promise<T> {
  const info = repositoryInfo(cwd);
  if (held.getStore()?.has(info.id)) return fn();
  const lock = path.join(info.commonDir, "cpi-locks", "writer");
  return withFileLock(lock, () => held.run(new Set([...(held.getStore() ?? []), info.id]), fn));
}

export function repositoryGit(cwd: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}): string {
  const output = execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000,
    env: { ...process.env, GIT_EXTERNAL_DIFF: "", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null", ...extraEnv },
  });
  return args.includes("-z") ? output : output.trim();
}
