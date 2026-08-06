/**
 * osc133.ts — OSC133 终端跳转 zone 标记（05）
 *
 * 用户/助手消息渲染输出外包 OSC133 zone，终端据此支持"跳转到上一条
 * 消息"。MessageList 窗口裁剪时按 zone 边界补偿标记（防止滚动时
 * 出现有 END 无 START 的半截 zone）。
 */

export const OSC133_ZONE_START = "\x1b]133;A\x07";
export const OSC133_ZONE_END = "\x1b]133;B\x07";
export const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
export const OSC133_ZONE_END_FINAL = OSC133_ZONE_END + OSC133_ZONE_FINAL;

/** 兼容别名（测试/外部引用） */
export const OSC133_START = OSC133_ZONE_START;
export const OSC133_END = OSC133_ZONE_END;

/** 给渲染行包裹 OSC133 zone（单行时 START 与 END 同行） */
export function wrapOsc133Zone(lines: string[]): string[] {
  if (lines.length === 0) return lines;
  if (lines.length === 1) {
    lines[0] = OSC133_ZONE_START + lines[0] + OSC133_ZONE_END_FINAL;
  } else {
    lines[0] = OSC133_ZONE_START + lines[0];
    lines[lines.length - 1] = OSC133_ZONE_END_FINAL + lines[lines.length - 1];
  }
  return lines;
}
