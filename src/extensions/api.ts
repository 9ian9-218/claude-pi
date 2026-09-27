/**
 * api.ts — ExtensionAPI（ADR-0006：全量开放接口）
 *
 * on：事件监听（映射 hook 事件 + 会话生命周期事件）
 * registerTool / registerCommand / appendEntry
 * ctx.ui 归 17。
 */
import { registerHook } from "../hook.ts";
import type { HookCallback } from "../hook.ts";
import { ui as uiProvider, registerEntryRenderer } from "../tui/ui-provider.ts";


export interface ExtensionToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => unknown | Promise<unknown>;
}

export interface ExtensionCommandHandler {
  (args: string, ui: unknown): Promise<string> | string;
}

export interface ExtensionUi {
  confirm(message: string, defaultValue?: boolean): Promise<boolean>;
  select<T extends string>(items: Array<{ value: T; label: string }>, title: string): Promise<T | null>;
  input(message: string): Promise<string | null>;
  notify(message: string, options?: { level?: "info" | "warning" | "error" }): void;
  custom(component: unknown): void;
}

export interface ExtensionAPI {
  on(event: string, handler: HookCallback): void;
  registerTool(tool: ExtensionToolDef): void;
  registerCommand(name: string, handler: ExtensionCommandHandler): void;
  appendEntry(customType: string, data?: unknown): string;
  ui: ExtensionUi;
  /** 自定义 entry 渲染器（customType → 文本） */
  registerEntryRenderer(customType: string, renderer: (data: unknown) => string): void;
}

export function createExtensionApi(deps: {
  registerTool: (t: ExtensionToolDef) => void;
  registerCommand: (n: string, h: ExtensionCommandHandler) => void;
  appendEntry: (t: string, d?: unknown) => string;
}): ExtensionAPI {
  return {
    on(event: string, handler: HookCallback): void {
      registerHook(event, handler);
    },
    registerTool: deps.registerTool,
    registerCommand: deps.registerCommand,
    appendEntry: deps.appendEntry,
    ui: uiProvider,
    registerEntryRenderer: (customType, renderer) => {
      registerEntryRenderer(customType, renderer);
    },
  };
}
