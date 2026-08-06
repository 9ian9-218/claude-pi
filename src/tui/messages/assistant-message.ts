/**
 * assistant-message.ts — 助手消息块（03，对齐 pi AssistantMessageComponent）
 *
 * 流式原位渲染：token 增量追加到同一 Markdown 组件；回合结束（08）可显示
 * 中止/错误状态行。thinking 块由 05 接入。
 */
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import type { TurnEndEvent } from "../../ui-events.ts";

export class AssistantMessageComponent extends Container {
  private markdown: Markdown;
  private text = "";
  private status: string | null = null;

  constructor() {
    super();
    this.markdown = new Markdown("", 1, 0, getMarkdownTheme());
    this.addChild(this.markdown);
  }

  getText(): string {
    return this.text;
  }

  appendDelta(delta: string): void {
    this.text += delta;
    this.markdown.setText(this.text);
  }

  setText(text: string): void {
    this.text = text;
    this.markdown.setText(text);
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
}
