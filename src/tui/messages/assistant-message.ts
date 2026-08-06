/**
 * assistant-message.ts — 助手消息块（03/05，对齐 pi AssistantMessageComponent）
 *
 * 双区结构：thinking 区（斜体灰字，Ctrl+T 折叠为 "Thinking…" 标签）+ 正文区
 * （Markdown 流式原位渲染）。回合结束（08）可显示中止/错误状态行。
 * 无工具调用时包 OSC133 终端跳转标记（05）。
 */
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import type { TurnEndEvent } from "../../ui-events.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

export class AssistantMessageComponent extends Container {
  private mainMarkdown: Markdown;
  private text = "";
  private thinkingText = "";
  private thinkingMarkdown: Markdown | null = null;
  private thinkingLabel: Text | null = null;
  private thinkingExpanded = true;
  private status: string | null = null;

  constructor() {
    super();
    this.mainMarkdown = new Markdown("", 1, 0, getMarkdownTheme());
    this.addChild(this.mainMarkdown);
  }

  getText(): string {
    return this.thinkingText ? `${this.thinkingText}\n${this.text}` : this.text;
  }

  // ── thinking（05）───────────────────────────────────────────────────

  appendThinking(delta: string): void {
    this.thinkingText += delta;
    if (this.thinkingExpanded) {
      this.ensureThinkingMarkdown();
      this.thinkingMarkdown?.setText(this.thinkingText);
    } else {
      this.ensureThinkingLabel();
    }
  }

  isThinkingExpanded(): boolean {
    return this.thinkingExpanded;
  }

  setThinkingExpanded(expanded: boolean): void {
    if (this.thinkingExpanded === expanded) return;
    this.thinkingExpanded = expanded;
    if (!this.thinkingText) return;
    if (expanded) {
      this.removeThinkingLabel();
      this.ensureThinkingMarkdown();
      this.thinkingMarkdown?.setText(this.thinkingText);
    } else {
      this.removeThinkingMarkdown();
      this.ensureThinkingLabel();
    }
  }

  private ensureThinkingMarkdown(): void {
    if (this.thinkingMarkdown) return;
    this.thinkingMarkdown = new Markdown("", 1, 0, getMarkdownTheme(), {
      color: (c) => theme.fg("thinkingText", c),
      italic: true,
    });
    // 插到正文 Markdown 之前
    const idx = this.children.indexOf(this.mainMarkdown);
    this.children.splice(idx, 0, this.thinkingMarkdown);
  }

  private removeThinkingMarkdown(): void {
    if (!this.thinkingMarkdown) return;
    const idx = this.children.indexOf(this.thinkingMarkdown);
    if (idx !== -1) this.children.splice(idx, 1);
    this.thinkingMarkdown = null;
  }

  private ensureThinkingLabel(): void {
    if (this.thinkingLabel) return;
    this.thinkingLabel = new Text(
      theme.italic(theme.fg("thinkingText", "Thinking…")),
      1,
      0,
    );
    const idx = this.children.indexOf(this.mainMarkdown);
    this.children.splice(idx, 0, this.thinkingLabel);
  }

  private removeThinkingLabel(): void {
    if (!this.thinkingLabel) return;
    const idx = this.children.indexOf(this.thinkingLabel);
    if (idx !== -1) this.children.splice(idx, 1);
    this.thinkingLabel = null;
  }

  // ── 正文流式（03）────────────────────────────────────────────────────

  appendDelta(delta: string): void {
    this.text += delta;
    this.mainMarkdown.setText(this.text);
  }

  setText(text: string): void {
    this.text = text;
    this.mainMarkdown.setText(text);
  }

  /** 回合结束状态（08）：中止/错误显示在块底部，对齐 pi */
  setTurnEnd(event: TurnEndEvent): void {
    if (event.stopReason === "aborted") {
      this.showStatus("Operation aborted");
    } else if (event.stopReason === "error") {
      this.showStatus(`Error: ${event.errorMessage ?? "Unknown error"}`);
    }
  }

  private showStatus(text: string): void {
    if (this.status === text) return;
    this.status = text;
    this.addChild(new Text(theme.fg("error", text), 1, 0));
  }

  // ── OSC133 终端跳转标记（05）────────────────────────────────────────

  render(width: number): string[] {
    const lines = super.render(width);
    if (lines.length === 0) return lines;
    if (lines.length === 1) {
      lines[0] = OSC133_ZONE_START + lines[0] + OSC133_ZONE_END + OSC133_ZONE_FINAL;
    } else {
      lines[0] = OSC133_ZONE_START + lines[0];
      lines[lines.length - 1] =
        OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
    }
    return lines;
  }
}
