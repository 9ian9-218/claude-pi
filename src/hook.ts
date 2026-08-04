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

import { getSystemPrompt, updateContext } from "./prompt.ts";
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

export async function triggerHooks(event: string, ...args: unknown[]): Promise<unknown> {
  const callbacks = HOOKS[event] ?? [];
  for (const callback of callbacks) {
    const result = await callback(...args);
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
