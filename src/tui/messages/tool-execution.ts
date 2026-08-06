/**
 * tool-execution.ts — 工具执行块（04，对齐 pi ToolExecutionComponent）
 *
 * 三态背景：pending 灰底（工具名+参数）→ result 后绿底成功 / 红底错误。
 * 超长输出自动折叠：只显示尾部 N 个可视行 + 折叠提示；Ctrl+O 展开/折叠。
 */
import { Box, Container, Text } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

/** 折叠时保留的尾部可视行数 */
export const COLLAPSED_MAX_LINES = 12;

export class ToolExecutionComponent extends Container {
  readonly toolName: string;
  readonly toolCallId: string;
  private argsText: string;
  private result: string | null = null;
  private isError = false;
  private expanded = false;
  private contentBox: Box;
  private contentText: Text;

  constructor(toolName: string, toolCallId: string, args: unknown) {
    super();
    this.toolName = toolName;
    this.toolCallId = toolCallId;
    this.argsText = this.formatArgs(args);
    this.contentBox = new Box(1, 1, (t) => theme.bg("toolPendingBg", t));
    this.contentText = new Text("", 0, 0);
    this.contentBox.addChild(this.contentText);
    this.addChild(this.contentBox);
    this.updateDisplay();
  }

  getText(): string {
    const base = `${this.toolName}(${this.argsText})`;
    return this.result ? `${base} -> ${this.result}` : base;
  }

  updateResult(result: string, isError: boolean): void {
    this.result = result;
    this.isError = isError;
    this.updateDisplay();
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    this.updateDisplay();
  }

  isExpanded(): boolean {
    return this.expanded;
  }

  hasResult(): boolean {
    return this.result !== null;
  }

  private formatArgs(args: unknown): string {
    if (args === null || args === undefined) return "";
    if (typeof args === "string") return args;
    try {
      return JSON.stringify(args, null, 2);
    } catch {
      return String(args);
    }
  }

  /** 折叠时截断为尾部 maxLines 个可视行（含包装换行） */
  private truncate(text: string, width: number, maxLines: number): { lines: string[]; skipped: number } {
    const temp = new Text(text, 0, 0);
    const all = temp.render(width);
    if (all.length <= maxLines) return { lines: all, skipped: 0 };
    return { lines: all.slice(-maxLines), skipped: all.length - maxLines };
  }

  private updateDisplay(): void {
    const bgFn = this.isError
      ? (t: string) => theme.bg("toolErrorBg", t)
      : this.result !== null
        ? (t: string) => theme.bg("toolSuccessBg", t)
        : (t: string) => theme.bg("toolPendingBg", t);
    this.contentBox.setBgFn(bgFn);

    const title = theme.fg("toolTitle", theme.bold(this.toolName));
    const argsBlock = this.argsText ? `\n${this.argsText}` : "";
    const resultBlock = this.result !== null ? `\n${this.result}` : "";
    const full = `${title}${argsBlock}${resultBlock}`;

    // 折叠：仅当有结果且未展开时截断；pending/展开显示全文
    if (this.result !== null && !this.expanded) {
      // 内容宽度 = 视口宽 - Box 左右 padding(2)
      const contentWidth = Math.max(20, this.widthHint - 2);
      const { lines, skipped } = this.truncate(full, contentWidth, COLLAPSED_MAX_LINES);
      if (skipped > 0) {
        const hint = theme.fg("dim", `… ${skipped} 行已折叠 · Ctrl+O 展开`);
        this.contentText.setText([...lines, hint].join("\n"));
        return;
      }
    }
    this.contentText.setText(full);
  }

  /** 渲染时由父级传入的宽度提示（updateDisplay 需要） */
  private widthHint = 80;

  render(width: number): string[] {
    this.widthHint = width;
    this.updateDisplay();
    return super.render(width);
  }
}
