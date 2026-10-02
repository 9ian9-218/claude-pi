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
  dispose(): void;
  on(event: string, handler: HookCallback): void;
  registerTool(tool: ExtensionToolDef): void;
  registerCommand(name: string, handler: ExtensionCommandHandler): void;
  appendEntry(customType: string, data?: unknown): string;
  ui: ExtensionUi;
  /** 自定义 entry 渲染器（customType → 文本） */
  registerEntryRenderer(customType: string, renderer: (data: unknown) => string): void;
}

export function createExtensionApi(deps: {
  registerTool: (t: ExtensionToolDef) => void | (() => void);
  registerCommand: (n: string, h: ExtensionCommandHandler) => void | (() => void);
  appendEntry: (t: string, d?: unknown) => string;
}): ExtensionAPI {
  const disposers: Array<() => void> = [];
  const remember = (disposer: void | (() => void)) => { if (disposer) disposers.push(disposer); };
  return {
    dispose() { for (const dispose of disposers.splice(0).reverse()) { try { dispose(); } catch { /* Continue disposal. */ } } },
    on(event: string, handler: HookCallback): void {
      remember(registerHook(event, handler));
    },
    registerTool: tool => remember(deps.registerTool(tool)),
    registerCommand: (name, handler) => remember(deps.registerCommand(name, handler)),
    appendEntry: deps.appendEntry,
    ui: uiProvider,
    registerEntryRenderer: (customType, renderer) => {
      remember(registerEntryRenderer(customType, renderer));
    },
  };
}
