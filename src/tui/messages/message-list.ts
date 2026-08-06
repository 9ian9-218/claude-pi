/**
 * message-list.ts — 聊天区消息列表（03）
 *
 * 组件化消息容器：持有 UserMessage/AssistantMessage/SystemMessage 等子组件，
 * 渲染时按视口高度从底部截取（offset>0 表示向上滚动），对齐 pi 的
 * chatContainer + 终端原生滚动语义。
 */
import { Container } from "@earendil-works/pi-tui";

export class MessageList extends Container {
  private offset = 0;
  private viewportHeight = 10;

  setViewportHeight(h: number): void {
    this.viewportHeight = Math.max(1, Math.floor(h));
  }

  getViewportHeight(): number {
    return this.viewportHeight;
  }

  /** 向上滚动一行（返回是否已到顶） */
  scrollUp(): boolean {
    const all = super.render(80);
    if (all.length <= this.viewportHeight) return true;
    const max = all.length - this.viewportHeight;
    if (this.offset >= max) return true;
    this.offset = Math.min(this.offset + 1, max);
    return this.offset >= max;
  }

  /** 向下滚动一行（返回是否已到底部） */
  scrollDown(): boolean {
    if (this.offset <= 0) return true;
    this.offset -= 1;
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

  render(width: number): string[] {
    const all = super.render(width);
    if (all.length <= this.viewportHeight) return all;
    const start = Math.max(0, all.length - this.viewportHeight - this.offset);
    return all.slice(start, start + this.viewportHeight);
  }
}
