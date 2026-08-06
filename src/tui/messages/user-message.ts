/**
 * user-message.ts — 用户消息块（03，对齐 pi UserMessageComponent）
 *
 * 背景色块 + Markdown，无角色前缀；终端跳转标记（OSC133）由 05 包裹。
 */
import { Box, Container, Markdown } from "@earendil-works/pi-tui";
import { getMarkdownTheme, theme } from "../theme/theme.ts";

export class UserMessageComponent extends Container {
  private text: string;

  constructor(text: string) {
    super();
    this.text = text;
    this.rebuild();
  }

  getText(): string {
    return this.text;
  }

  private rebuild(): void {
    this.clear();
    const contentBox = new Box(1, 1, (content) => theme.bg("userMessageBg", content));
    contentBox.addChild(
      new Markdown(this.text, 0, 0, getMarkdownTheme(), {
        color: (content) => theme.fg("userMessageText", content),
      }),
    );
    this.addChild(contentBox);
  }
}
