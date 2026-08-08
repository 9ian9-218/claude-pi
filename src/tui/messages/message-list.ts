/**
 * message-list.ts — 聊天区消息列表（03/架构 D）
 *
 * 组件化消息容器：持有 UserMessage/AssistantMessage/SystemMessage 等子组件，
 * 渲染时按视口高度从底部截取（offset>0 表示向上滚动）。窗口切片与 OSC133
 * zone 补偿逻辑在 viewport-window.ts（深模块，纯函数）。行数统计用最近
 * 实际渲染宽度，消除硬编码宽度不一致。
 */
import { Container } from "@earendil-works/pi-tui";
import { sliceViewport } from "./viewport-window.ts";

export class MessageList extends Container {
  private offset = 0;
  private viewportHeight = 10;
  private lastRenderWidth = 80;

  setViewportHeight(h: number): void {
    this.viewportHeight = Math.max(1, Math.floor(h));
  }

  getViewportHeight(): number {
    return this.viewportHeight;
  }

  /** 向上滚动 lines 行（默认 1；PgUp 传视口高度）；返回是否已到顶 */
  scrollUp(lines = 1): boolean {
    const { totalLines } = this.measure();
    if (totalLines <= this.viewportHeight) return true;
    const max = totalLines - this.viewportHeight;
    this.offset = Math.min(this.offset + lines, max);
    return this.offset >= max;
  }

  /** 向下滚动 lines 行（默认 1；PgDn 传视口高度）；返回是否已到底部 */
  scrollDown(lines = 1): boolean {
    if (this.offset <= 0) return true;
    this.offset = Math.max(0, this.offset - lines);
    return this.offset <= 0;
  }

  /** 回到底部（跟随最新内容） */
  scrollToBottom(): void {
    this.offset = 0;
  }

  isScrolledUp(): boolean {
    return this.offset > 0;
  }

  /** 全部子组件文本拼接（测试/导出用） */
  getText(): string {
    return this.children
      .map((c) => {
        const t = (c as { getText?: () => string }).getText;
        return t ? t.call(c) : "";
      })
      .join("\n");
  }

  invalidate(): void {
    super.invalidate();
  }

  /** 用最近渲染宽度统计全部行数（滚动上限计算） */
  private measure(): { totalLines: number } {
    const childRenders = this.renderChildren(this.lastRenderWidth);
    let total = 0;
    for (const lines of childRenders) {
      total += lines.length;
    }
    return { totalLines: total };
  }

  private renderChildren(width: number): string[][] {
    const childRenders: string[][] = [];
    for (const child of this.children) {
      childRenders.push(child.render(width));
    }
    return childRenders;
  }

  render(width: number): string[] {
    this.lastRenderWidth = width;
    const childRenders = this.renderChildren(width);
    return sliceViewport(childRenders, this.viewportHeight, this.offset).lines;
  }
}
