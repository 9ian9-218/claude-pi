/**
 * scrollback.ts — Markdown 滚动视口组件
 *
 * 内部维护全文，render(width) 时按视口高度从底部截取（offset=0 跟随底部）。
 */
import { Markdown, type MarkdownTheme, type Component } from "@earendil-works/pi-tui";

export const DEFAULT_MARKDOWN_THEME: MarkdownTheme = {
  heading: (t) => `\x1b[1;36m${t}\x1b[0m`,
  link: (t) => `\x1b[4;34m${t}\x1b[0m`,
  linkUrl: (t) => `\x1b[90m${t}\x1b[0m`,
  code: (t) => `\x1b[33m${t}\x1b[0m`,
  codeBlock: (t) => `\x1b[38;5;244m${t}\x1b[0m`,
  codeBlockBorder: (t) => `\x1b[90m${t}\x1b[0m`,
  quote: (t) => `\x1b[90m${t}\x1b[0m`,
  quoteBorder: (t) => `\x1b[90m${t}\x1b[0m`,
  hr: (t) => `\x1b[90m${t}\x1b[0m`,
  listBullet: (t) => `\x1b[36m${t}\x1b[0m`,
  bold: (t) => `\x1b[1m${t}\x1b[0m`,
  italic: (t) => `\x1b[3m${t}\x1b[0m`,
  strikethrough: (t) => `\x1b[9m${t}\x1b[0m`,
  underline: (t) => `\x1b[4m${t}\x1b[0m`,
};

export class Scrollback implements Component {
  private markdown: Markdown;
  private text = "";
  private offset = 0;
  private viewportHeight = 10;

  constructor(text = "") {
    this.markdown = new Markdown("", 0, 0, DEFAULT_MARKDOWN_THEME);
    if (text) this.setText(text);
  }

  setViewportHeight(h: number): void {
    this.viewportHeight = Math.max(1, h);
  }

  getViewportHeight(): number {
    return this.viewportHeight;
  }

  getText(): string {
    return this.text;
  }

  setText(text: string): void {
    this.text = text;
    this.markdown.setText(text);
    this.offset = 0;
  }

  append(text: string): void {
    this.setText(this.text + text);
  }

  clear(): void {
    this.setText("");
  }

  scrollUp(): void {
    const all = this.markdown.render(80);
    if (all.length > this.viewportHeight) {
      this.offset = Math.min(this.offset + 1, all.length - this.viewportHeight);
    }
  }

  scrollDown(): void {
    this.offset = Math.max(0, this.offset - 1);
  }

  invalidate(): void {
    this.markdown.invalidate();
  }

  render(width: number): string[] {
    const all = this.markdown.render(width);
    if (all.length <= this.viewportHeight) return all;
    const start = Math.max(0, all.length - this.viewportHeight - this.offset);
    return all.slice(start, start + this.viewportHeight);
  }
}
