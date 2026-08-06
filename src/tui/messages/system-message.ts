/**
 * system-message.ts — 系统消息（03）
 *
 * 命令回显、队友消息、后台任务通知等非对话内容；dim + muted 样式，
 * 特殊类型（队友/通知）用 accent/success 着色区分。
 */
import { Container, Text } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

export type SystemMessageKind = "muted" | "accent" | "success" | "warning" | "error";

const KIND_COLORS: Record<SystemMessageKind, string> = {
  muted: "muted",
  accent: "accent",
  success: "success",
  warning: "warning",
  error: "error",
};

export class SystemMessageComponent extends Container {
  private text: string;

  constructor(text: string, kind: SystemMessageKind = "muted") {
    super();
    this.text = text;
    const color = KIND_COLORS[kind];
    this.addChild(new Text(theme.fg(color, theme.dim(text)), 1, 0));
  }

  getText(): string {
    return this.text;
  }
}
