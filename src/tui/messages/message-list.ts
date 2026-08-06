/**
 * message-list.ts — 聊天区消息列表（03）
 *
 * 组件化消息容器：持有 UserMessage/AssistantMessage/SystemMessage 等子组件，
 * 渲染时按视口高度从底部截取（offset>0 表示向上滚动），对齐 pi 的
 * chatContainer + 终端原生滚动语义。
 *
 * 窗口裁剪按子组件边界进行；从 OSC133 zone 中间切入/切出时补齐标记
 * （防止滚动状态下终端收到半截 zone）。
 */
import { Container } from "@earendil-works/pi-tui";
import { OSC133_ZONE_END_FINAL, OSC133_ZONE_START } from "./osc133.ts";

export class MessageList extends Container {
  private offset = 0;
  private viewportHeight = 10;

  setViewportHeight(h: number): void {
    this.viewportHeight = Math.max(1, Math.floor(h));
  }

  getViewportHeight(): number {
    return this.viewportHeight;
  }

  /** 向上滚动 lines 行（默认 1；PgUp 传视口高度）；返回是否已到顶 */
  scrollUp(lines = 1): boolean {
    const all = super.render(80);
    if (all.length <= this.viewportHeight) return true;
    const max = all.length - this.viewportHeight;
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

  render(width: number): string[] {
    // 逐子组件渲染并记录行区间（子组件自身包 OSC133 zone）
    const childRenders: string[][] = [];
    let total = 0;
    for (const child of this.children) {
      const lines = child.render(width);
      childRenders.push(lines);
      total += lines.length;
    }
    if (total <= this.viewportHeight) {
      return childRenders.flat();
    }
    const start = Math.max(0, total - this.viewportHeight - this.offset);
    const end = Math.min(total, start + this.viewportHeight);

    const out: string[] = [];
    let cursor = 0;
    for (const lines of childRenders) {
      const childStart = cursor;
      const childEnd = cursor + lines.length;
      cursor = childEnd;
      if (childEnd <= start || childStart >= end) continue; // 完全在窗口外
      const from = Math.max(0, start - childStart);
      const to = Math.min(lines.length, end - childStart);
      const slice = lines.slice(from, to);
      // zone 补偿：子组件首行带 START 标记即视为包 zone 的消息组件
      if (slice.length > 0 && lines[0].startsWith(OSC133_ZONE_START)) {
        if (from > 0) {
          // 中间切入：补 START（原标记已被裁掉）
          slice[0] = OSC133_ZONE_START + slice[0];
        }
        if (to < lines.length) {
          // 中间切出：补 END+FINAL（原标记已被裁掉）
          slice[slice.length - 1] = slice[slice.length - 1] + OSC133_ZONE_END_FINAL;
        }
      }
      out.push(...slice);
    }
    return out;
  }
}
