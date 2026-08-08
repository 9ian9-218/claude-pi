import { describe, it, expect } from "vitest";
import { sliceViewport } from "./messages/viewport-window.ts";
import { OSC133_END, OSC133_START } from "./messages/osc133.ts";

/** 构造带 zone 标记的消息渲染行：首行带 START，末行带 END */
function zonedLines(n: number, prefix = "m"): string[] {
  const lines = Array.from({ length: n }, (_, i) => `${prefix}${i}`);
  lines[0] = OSC133_START + lines[0];
  lines[lines.length - 1] = lines[lines.length - 1] + "\x1b]133;B\x07\x1b]133;C\x07";
  return lines;
}

describe("sliceViewport（架构 D）", () => {
  it("总行数不超视口时原样返回", () => {
    const r = sliceViewport([["a"], ["b"]], 5, 0);
    expect(r.lines).toEqual(["a", "b"]);
    expect(r.totalLines).toBe(2);
    expect(r.windowStart).toBe(0);
  });

  it("超视口时从底部截取（offset=0）", () => {
    const r = sliceViewport([["a", "b", "c", "d"]], 2, 0);
    expect(r.lines).toEqual(["c", "d"]);
    expect(r.totalLines).toBe(4);
  });

  it("offset 上翻移动窗口", () => {
    const r = sliceViewport([["a", "b", "c", "d"]], 2, 1);
    expect(r.lines).toEqual(["b", "c"]);
  });

  it("从 zone 中间切入时补 START", () => {
    // 3 行 zone 消息 + 2 行普通消息；视口 2、offset 3 → 窗口切入 zone 中间
    const childRenders = [zonedLines(3), ["x", "y"]];
    const r = sliceViewport(childRenders, 2, 3);
    expect(r.lines[0].startsWith(OSC133_START)).toBe(true);
    expect(r.lines.join("")).toContain(OSC133_END);
  });

  it("从 zone 中间切出时补 END+FINAL", () => {
    // 5 行 zone 消息 + 1 行普通消息；视口 2、offset 3 → 窗口 = 行 2,3
    // （zone 中间两行）→ 最后可见行是 zone 中间行 → 补 END
    const childRenders = [zonedLines(5), ["x"]];
    const r = sliceViewport(childRenders, 2, 3);
    expect(r.windowStart).toBe(1);
    expect(r.lines.join("")).toContain(OSC133_END);
  });

  it("窗口完整落在 zone 内时标记不重复叠加", () => {
    const childRenders = [zonedLines(3)];
    const first = sliceViewport(childRenders, 5, 0);
    expect(first.lines.join("").split(OSC133_START).length - 1).toBe(1);
    const again = sliceViewport(childRenders, 5, 0);
    expect(again.lines.join("").split(OSC133_START).length - 1).toBe(1);
  });

  it("普通消息（无 zone）窗口切片不产生补偿", () => {
    const r = sliceViewport([["a", "b", "c"]], 2, 0);
    expect(r.lines).toEqual(["b", "c"]);
    expect(r.lines[0].startsWith(OSC133_START)).toBe(false);
  });
});
