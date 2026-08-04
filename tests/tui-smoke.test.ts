import { describe, it, expect } from "vitest";
import { Text, TUI, type Terminal } from "@earendil-works/pi-tui";

/**
 * 冒烟测试：验证 pi-tui（0.83.0 锁定版）在 claude-pi 工程中可渲染。
 * 组件 render(width) 为纯函数（S2 接缝），TUI 用 FakeTerminal 注入。
 */
class FakeTerminal implements Terminal {
  writes: string[] = [];
  start(): void {}
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.writes.push(data);
  }
  get columns(): number {
    return 40;
  }
  get rows(): number {
    return 10;
  }
  get kittyProtocolActive(): boolean {
    return false;
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
}

const nextTick = () => new Promise<void>((resolve) => process.nextTick(resolve));

describe("pi-tui 组件渲染（S2）", () => {
  it("Text 组件 render(width) 输出正确行（默认 padding 1，行填满宽度）", () => {
    const text = new Text("hello");
    const lines = text.render(20);
    expect(lines.length).toBe(3);
    expect(lines.every((l) => l.length === 20)).toBe(true);
    expect(lines[1].trim()).toBe("hello");
  });

  it("长文本按宽度换行", () => {
    const text = new Text("a".repeat(50));
    const lines = text.render(20);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((l) => l.length <= 20)).toBe(true);
  });

  it("TUI + FakeTerminal 冒烟：挂载组件并渲染出内容", async () => {
    const terminal = new FakeTerminal();
    const tui = new TUI(terminal);
    tui.addChild(new Text("claude-pi smoke"));
    tui.requestRender(true);
    await nextTick();
    tui.stop();
    const all = terminal.writes.join("");
    expect(all).toContain("claude-pi smoke");
  });
});
