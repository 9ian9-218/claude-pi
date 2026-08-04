/**
 * ui-provider.ts — ctx.ui 实现（17）
 *
 * 当前 TUI 宿主（cli 设置）；非 TUI 模式回退：confirm→false、select/input→null、
 * notify→console.log、custom→忽略。
 */
import type { Component } from "@earendil-works/pi-tui";
import type { TuiApp } from "./app.ts";

let app: TuiApp | null = null;

export function setTuiApp(a: TuiApp | null): void {
  app = a;
}

export function getTuiApp(): TuiApp | null {
  return app;
}

export interface UiNotifyOptions {
  level?: "info" | "warning" | "error";
}

export const ui = {
  confirm(message: string, defaultValue = false): Promise<boolean> {
    const a = app;
    if (!a) return Promise.resolve(defaultValue);
    return a.showSelector(
      [
        { value: "yes", label: "是" },
        { value: "no", label: "否" },
      ],
      message,
    ).then((picked) => (picked ? picked.value === "yes" : defaultValue));
  },

  select<T extends string>(items: Array<{ value: T; label: string }>, title: string): Promise<T | null> {
    const a = app;
    if (!a) return Promise.resolve(null);
    return a
      .showSelector(items.map((i) => ({ value: i.value, label: i.label })), title)
      .then((picked) => (picked ? (picked.value as T) : null));
  },

  input(message: string): Promise<string | null> {
    const a = app;
    if (!a) return Promise.resolve(null);
    return a.showInputDialog(message);
  },

  notify(message: string, options: UiNotifyOptions = {}): void {
    const a = app;
    if (a) {
      const color =
        options.level === "error" ? "1;31" : options.level === "warning" ? "1;33" : "1;34";
      a.appendMessage("system", `\x1b[${color}m${message}\x1b[0m`);
    } else {
      console.log(`[notify] ${message}`);
    }
  },

  custom(component: Component): void {
    const a = app;
    if (!a) return;
    a.mountCustomComponent(component);
  },
};

// ── 自定义 entry 渲染器（customType → 文本） ─────────────────────────────

const entryRenderers = new Map<string, (data: unknown) => string>();

export function registerEntryRenderer(customType: string, renderer: (data: unknown) => string): void {
  entryRenderers.set(customType, renderer);
}

export function renderCustomEntry(customType: string, data: unknown): string | null {
  const renderer = entryRenderers.get(customType);
  if (!renderer) return null;
  return renderer(data);
}

export function listEntryRenderers(): string[] {
  return [...entryRenderers.keys()];
}

export function clearEntryRenderers(): void {
  entryRenderers.clear();
}
