/**
 * user-message.ts — 用户消息块（03，对齐 pi UserMessageComponent）
 *
 * 背景色块 + Markdown，无角色前缀；包 OSC133 终端跳转标记（05）。
 */
import { Box, Container, Markdown } from "@earendil-works/pi-tui";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { OSC133_ZONE_END_FINAL, OSC133_ZONE_START, wrapOsc133Zone } from "./osc133.ts";

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

  render(width: number): string[] {
    return wrapOsc133Zone(super.render(width));
  }
}
