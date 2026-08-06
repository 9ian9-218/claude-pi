/**
 * select-style.ts — 共享选择器/弹窗主题（09）
 *
 * 全部 overlay（权限、会话命令、ctx.ui、模型选择器）统一取主题色。
 */
import type { SelectListTheme } from "@earendil-works/pi-tui";
import { theme } from "./theme/theme.ts";

export const SELECT_LIST_THEME: SelectListTheme = {
  selectedPrefix: (t) => theme.fg("accent", `▸ ${t}`),
  selectedText: (t) => theme.bold(t),
  description: (t) => theme.fg("dim", t),
  scrollInfo: (t) => theme.fg("dim", t),
  noMatch: (t) => theme.fg("dim", t),
};

/** overlay 标题样式 */
export function overlayTitle(title: string): string {
  return theme.fg("accent", theme.bold(title));
}
