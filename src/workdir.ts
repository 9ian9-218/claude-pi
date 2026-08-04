/**
 * workdir.ts — 有效工作目录（对齐 config.py 的 get_workdir / set_worktree_override）
 *
 * AsyncLocalStorage 提供线程本地语义的 TS 等价：每个 Agent Loop 上下文
 * （主 agent / teammate / worktree 隔离）持有自己的可变 workdir 上下文。
 * claim 任务时 setWorktreeOverride(path) 切换，complete 时置 null 恢复。
 */
import { AsyncLocalStorage } from "node:async_hooks";

interface WorkdirContext {
  workdir: string;
}

const workdirStore = new AsyncLocalStorage<WorkdirContext>();

/** 当前有效工作目录（无上下文时为 process.cwd()） */
export function getWorkdir(): string {
  return workdirStore.getStore()?.workdir ?? process.cwd();
}

/** 在指定目录上下文中运行 fn（同步或异步，随 AsyncLocalStorage 传播） */
export function runWithWorkdir<T>(dir: string, fn: () => T): T {
  return workdirStore.run({ workdir: dir }, fn);
}

/** 更新当前上下文的 worktree 覆盖（置 null 恢复默认目录） */
export function setWorktreeOverride(path: string | null): void {
  const ctx = workdirStore.getStore();
  if (ctx) {
    ctx.workdir = path ?? process.cwd();
  }
}
