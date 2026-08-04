/**
 * workdir.ts — 有效工作目录（对齐 config.py 的 get_workdir / set_worktree_override）
 *
 * AsyncLocalStorage 提供线程本地语义的 TS 等价：每个 Agent Loop 上下文
 * （主 agent / teammate / worktree 隔离）拥有自己的工作目录。
 * 08（worktree 隔离）将基于 runWithWorkdir 切换。
 */
import { AsyncLocalStorage } from "node:async_hooks";

const workdirStore = new AsyncLocalStorage<string>();

/** 当前有效工作目录（无覆盖时为 process.cwd()） */
export function getWorkdir(): string {
  return workdirStore.getStore() ?? process.cwd();
}

/** 在指定目录上下文中运行 fn（同步或异步，随 AsyncLocalStorage 传播） */
export function runWithWorkdir<T>(dir: string, fn: () => T): T {
  return workdirStore.run(dir, fn);
}
