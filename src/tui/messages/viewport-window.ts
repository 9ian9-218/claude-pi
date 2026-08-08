/**
 * viewport-window.ts — 渲染窗口状态机（架构 D）
 *
 * 从 MessageList 拆出：把「子组件渲染行数组 + 视口 + 偏移」切出可见窗口，
 * 并在 OSC133 zone 被从中间切开时补齐标记（切入补 START、切出补 END）。
 * 纯函数，无组件依赖，可独立测试。
 */
import { OSC133_ZONE_END_FINAL, OSC133_ZONE_START } from "./osc133.ts";

export interface WindowSlice {
  /** 窗口内可见行（含 zone 补偿标记） */
  lines: string[];
  /** 全部行数（用于滚动上限计算） */
  totalLines: number;
  /** 当前偏移对应的窗口起始行（全部行中的索引） */
  windowStart: number;
}

/**
 * 从各子组件的渲染行中切出视口窗口。
 *
 * @param childRenders 每个子组件的渲染行（子组件自身包 OSC133 zone）
 * @param viewportHeight 视口行数
 * @param offset 从底部向上滚动的行数（0 = 跟随底部）
 */
export function sliceViewport(
  childRenders: string[][],
  viewportHeight: number,
  offset: number,
): WindowSlice {
  let total = 0;
  for (const lines of childRenders) {
    total += lines.length;
  }
  if (total <= viewportHeight) {
    return { lines: childRenders.flat(), totalLines: total, windowStart: 0 };
  }
  const windowStart = Math.max(0, total - viewportHeight - offset);
  const windowEnd = Math.min(total, windowStart + viewportHeight);

  const out: string[] = [];
  let cursor = 0;
  for (const lines of childRenders) {
    const childStart = cursor;
    const childEnd = cursor + lines.length;
    cursor = childEnd;
    if (childEnd <= windowStart || childStart >= windowEnd) continue; // 完全在窗口外
    const from = Math.max(0, windowStart - childStart);
    const to = Math.min(lines.length, windowEnd - childStart);
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
  return { lines: out, totalLines: total, windowStart };
}
