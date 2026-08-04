/**
 * hook.ts — Hook 注册表（对齐 src/hook.py）
 *
 * 扩展逻辑挂载在事件上，不侵入主循环。任一回调返回非 null/undefined
 * 则短路并返回该值（PreToolUse 用于阻止工具执行）。
 *
 * 02a 内置：UserPromptSubmit（工作目录提示）、Stop（会话统计）。
 * PreToolUse/PostToolUse（schema 校验/权限/日志/大输出告警）归 02b；
 * memory_stop_hook 归 05。
 */

export type HookCallback = (...args: any[]) => unknown;

export function registerHook(event: string, callback: HookCallback): void {
  if (!HOOKS[event]) HOOKS[event] = [];
  HOOKS[event].push(callback);
}

export function triggerHooks(event: string, ...args: unknown[]): unknown {
  const callbacks = HOOKS[event] ?? [];
  for (const callback of callbacks) {
    const result = callback(...args);
    if (result !== null && result !== undefined) {
      return result;
    }
  }
  return undefined;
}

// ── 内置 hook ─────────────────────────────────────────────────────────────

export function contextInjectHook(query: string): void {
  console.log(`\x1b[90m[HOOK] UserPromptSubmit: working in ${process.cwd()}\x1b[0m`);
}

export function summaryHook(messages: { role?: string }[]): void {
  const toolCount = messages.filter((m) => m.role === "tool").length;
  console.log(`\x1b[90m[HOOK] Stop: session used ${toolCount} tool calls\x1b[0m`);
}

// ── 注册表 ────────────────────────────────────────────────────────────────

export const HOOKS: Record<string, HookCallback[]> = {
  UserPromptSubmit: [contextInjectHook],
  Stop: [summaryHook],
};
