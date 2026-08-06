/**
 * user-message.ts — 用户消息块（03，对齐 pi UserMessageComponent）
 *
 * 背景色块 + Markdown，无角色前缀；包 OSC133 终端跳转标记（05）。
 */
import { Box, Container, Markdown } from "@earendil-works/pi-tui";
import { getMarkdownTheme, theme } from "../theme/theme.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

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
