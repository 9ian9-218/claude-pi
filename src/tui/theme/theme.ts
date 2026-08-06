/**
 * theme.ts — 主题系统（02，对齐 pi 的 theme 模块）
 *
 * dark/light 两个 JSON 主题（colors 表），Theme 类提供 fg/bg/bold/italic
 * 取色助手，Markdown 渲染从主题取色。默认 dark，setTheme("light") 可切换。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { MarkdownTheme } from "@earendil-works/pi-tui";

export type ThemeName = "dark" | "light";

export interface ThemeColors {
  accent: string;
  border: string;
  borderAccent: string;
  borderMuted: string;
  success: string;
  error: string;
  warning: string;
  muted: string;
  dim: string;
  text: string;
  thinkingText: string;
  selectedBg: string;
  userMessageBg: string;
  userMessageText: string;
  customMessageBg: string;
  customMessageText: string;
  customMessageLabel: string;
  toolPendingBg: string;
  toolSuccessBg: string;
  toolErrorBg: string;
  toolTitle: string;
  toolOutput: string;
  mdHeading: string;
  mdLink: string;
  mdLinkUrl: string;
  mdCode: string;
  mdCodeBlock: string;
  mdCodeBlockBorder: string;
  mdQuote: string;
  mdQuoteBorder: string;
  mdHr: string;
  mdListBullet: string;
  toolDiffAdded: string;
  toolDiffRemoved: string;
  toolDiffContext: string;
  thinkingOff: string;
  thinkingMinimal: string;
  thinkingLow: string;
  thinkingMedium: string;
  thinkingHigh: string;
  thinkingXhigh: string;
  thinkingMax: string;
  bashMode: string;
  [key: string]: string;
}

const THEMES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)));

// ── hex → 24-bit 真彩 ANSI（对齐 pi 的 chalk 真彩输出） ────────────────

function fgAnsi(hex: string): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `\x1b[38;2;${r};${g};${b}m`;
}

function bgAnsi(hex: string): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `\x1b[48;2;${r};${g};${b}m`;
}

// ── Theme ───────────────────────────────────────────────────────────────

export class Theme {
  readonly name: ThemeName;
  private fgCache = new Map<string, string>();
  private bgCache = new Map<string, string>();

  constructor(name: ThemeName) {
    this.name = name;
    const colors = loadThemeColors(name);
    for (const [key, value] of Object.entries(colors)) {
      this.fgCache.set(key, fgAnsi(value));
      this.bgCache.set(key, bgAnsi(value));
    }
  }

  fg(color: string, text: string): string {
    const ansi = this.fgCache.get(color);
    if (!ansi) throw new Error(`Unknown theme color: ${color}`);
    return `${ansi}${text}\x1b[39m`;
  }

  bg(color: string, text: string): string {
    const ansi = this.bgCache.get(color);
    if (!ansi) throw new Error(`Unknown theme background color: ${color}`);
    return `${ansi}${text}\x1b[49m`;
  }

  bold(text: string): string {
    return `\x1b[1m${text}\x1b[22m`;
  }

  italic(text: string): string {
    return `\x1b[3m${text}\x1b[23m`;
  }

  underline(text: string): string {
    return `\x1b[4m${text}\x1b[24m`;
  }

  dim(text: string): string {
    return `\x1b[2m${text}\x1b[22m`;
  }

  getFgAnsi(color: string): string {
    const ansi = this.fgCache.get(color);
    if (!ansi) throw new Error(`Unknown theme color: ${color}`);
    return ansi;
  }

  getBgAnsi(color: string): string {
    const ansi = this.bgCache.get(color);
    if (!ansi) throw new Error(`Unknown theme background color: ${color}`);
    return ansi;
  }
}

function loadThemeColors(name: ThemeName): ThemeColors {
  const raw = JSON.parse(
    fs.readFileSync(path.join(THEMES_DIR, `${name}.json`), "utf8"),
  ) as { colors: ThemeColors };
  return raw.colors;
}

// ── 单例与切换 ──────────────────────────────────────────────────────────

let currentTheme: Theme = new Theme("dark");

export function getTheme(): Theme {
  return currentTheme;
}

export function setTheme(name: ThemeName): void {
  currentTheme = new Theme(name);
}

export function getAvailableThemes(): ThemeName[] {
  return ["dark", "light"];
}

export function getThemeByName(name: string): Theme {
  if (name === "light") return new Theme("light");
  return new Theme("dark");
}

export const theme: Theme = new Proxy(
  {},
  {
    get(_target, prop: string) {
      const t = currentTheme;
      const member = (t as unknown as Record<string, unknown>)[prop];
      if (typeof member === "function") {
        return member.bind(t);
      }
      return member;
    },
  },
) as unknown as Theme;

// ── Markdown 主题 ───────────────────────────────────────────────────────

export function getMarkdownTheme(): MarkdownTheme {
  const t = currentTheme;
  return {
    heading: (s) => t.fg("mdHeading", t.bold(s)),
    link: (s) => t.fg("mdLink", s),
    linkUrl: (s) => t.fg("mdLinkUrl", s),
    code: (s) => t.fg("mdCode", s),
    codeBlock: (s) => t.fg("mdCodeBlock", s),
    codeBlockBorder: (s) => t.fg("mdCodeBlockBorder", s),
    quote: (s) => t.fg("mdQuote", s),
    quoteBorder: (s) => t.fg("mdQuoteBorder", s),
    hr: (s) => t.fg("mdHr", s),
    listBullet: (s) => t.fg("mdListBullet", s),
    bold: (s) => t.bold(s),
    italic: (s) => t.italic(s),
    strikethrough: (s) => `\x1b[9m${s}\x1b[29m`,
    underline: (s) => t.underline(s),
  };
}
