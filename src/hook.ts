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

import { getToolParameters, validateArgs } from "./tool.ts";
import { memoryStopHook } from "./memory.ts";
import { permissionHookWithBubble } from "./permission-sync.ts";

export type HookCallback = (...args: any[]) => unknown;

export function registerHook(event: string, callback: HookCallback): () => void {
  if (!HOOKS[event]) HOOKS[event] = [];
  HOOKS[event].push(callback);
  return () => {
    const list = HOOKS[event];
    if (list) {
      const idx = list.indexOf(callback);
      if (idx >= 0) list.splice(idx, 1);
    }
  };
}

/** hook 调用超时：扩展 hook 卡住不该让整个回合永远不动（CLAUDE_PI_HOOK_TIMEOUT_MS 可覆盖） */
export function hookTimeoutMs(): number {
  const raw = Number.parseInt(process.env["CLAUDE_PI_HOOK_TIMEOUT_MS"] ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
}

/** 调用单个 hook，超时即拒绝（同步抛错也会被转成 rejected promise） */
async function callHook(
  callback: HookCallback,
  args: unknown[],
  timeoutMs: number,
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => callback(...args)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`超过 ${timeoutMs}ms 未返回`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function triggerHooks(event: string, ...args: unknown[]): Promise<unknown> {
  const callbacks = HOOKS[event] ?? [];
  const timeoutMs = hookTimeoutMs();
  for (const callback of callbacks) {
    let result: unknown;
    try {
      result = await callHook(callback, args, timeoutMs);
    } catch (e) {
      // 扩展 hook 抛错（ADR-0006 无信任门）不该带走整个会话，也不该挡住后续 hook
      console.log(
        `  \x1b[31m[hook] ${event} 抛出异常，已跳过：${String((e as Error)?.message ?? e)}\x1b[0m`,
      );
      continue;
    }
    if (result !== null && result !== undefined) {
      return result;
    }
  }
  return undefined;
}

// ── 内置 hook ─────────────────────────────────────────────────────────────

export function contextInjectHook(): void {
  console.log(`\x1b[90m[HOOK] UserPromptSubmit: working in ${process.cwd()}\x1b[0m`);
}

export function summaryHook(messages: { role?: string }[]): void {
  const toolCount = messages.filter((m) => m.role === "tool").length;
  console.log(`\x1b[90m[HOOK] Stop: session used ${toolCount} tool calls\x1b[0m`);
}

// ── PreToolUse / PostToolUse（02b） ────────────────────────────────────────

export interface ToolBlock {
  name: string;
  input: Record<string, unknown>;
  id?: string;
}

/** PreToolUse：schema + 路径校验（须在 permissionHook 之前） */
export function validateHook(block: ToolBlock): string | null {
  const schema = getToolParameters(block.name);
  if (schema === null) {
    return `Unknown tool: ${block.name}`;
  }
  return validateArgs(block.input, schema);
}

export function logHook(block: ToolBlock): void {
  console.log(`\x1b[90m[HOOK] ${block.name}(...)\x1b[0m`);
}

export function largeOutputHook(block: ToolBlock, output: unknown): void {
  if (String(output).length > 100_000) {
    console.log(`\x1b[33m[HOOK] ⚠ Large output from ${block.name}\x1b[0m`);
  }
}

// ── 注册表 ────────────────────────────────────────────────────────────────

export const HOOKS: Record<string, HookCallback[]> = {
  UserPromptSubmit: [],
  PreToolUse: [],
  PostToolUse: [],
  Stop: [],
};

/** 安装内置 hook（测试可调用重置） */
export function installBuiltinHooks(): void {
  HOOKS["UserPromptSubmit"] = [contextInjectHook];
  HOOKS["PreToolUse"] = [validateHook, permissionHookWithBubble, logHook];
  HOOKS["PostToolUse"] = [largeOutputHook];
  HOOKS["Stop"] = [summaryHook, memoryStopHook];
}

installBuiltinHooks();
