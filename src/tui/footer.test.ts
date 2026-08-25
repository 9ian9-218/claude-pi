import { describe, it, expect } from "vitest";
import { TuiApp } from "./app.ts";
import { theme } from "./theme/theme.ts";
import type { Terminal } from "@earendil-works/pi-tui";

class FakeTerminal implements Terminal {
  writes: string[] = [];
  start(onInput: (data: string) => void): void {
    this.onInput = onInput;
  }
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.writes.push(data);
  }
  get columns(): number {
    return 80;
  }
  get rows(): number {
    return 24;
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
  onInput?: (data: string) => void;
}

describe("Footer 状态栏（07）", () => {
  it("两行布局：第 1 行 cwd（含 git 分支），第 2 行统计 + 模型名右对齐", () => {
    const term = new FakeTerminal();
    const app = new TuiApp({
      terminal: term,
      onQuery: () => {},
      statusText: () => "openai/gpt-4o | /home/test/proj",
      footerStats: () => ({
        totals: { input: 714000, output: 136000, cacheRead: 20000000, cacheWrite: 0, cost: 0.357 },
        latestCacheHitRate: 99.6,
        context: { tokens: 500000, percent: 50, contextWindow: 1000000 },
        branch: "main",
      }),
    });
    const lines = app["footer"].render(80).join("");
    expect(lines).toContain("/home/test/proj (main)");
    expect(lines).toContain("↑714k");
    expect(lines).toContain("↓136k");
    expect(lines).toContain("R20M");
    expect(lines).toContain("CH99.6%");
    expect(lines).toContain("$0.357");
    expect(lines).toContain("50.0%/1.0M");
    expect(lines).toContain("openai/gpt-4o");
    expect(lines).toContain(theme.getFgAnsi("dim"));
  });

  it("统计无数据时元素隐藏：无会话 → 第 2 行只有模型名", () => {
    const term = new FakeTerminal();
    const app = new TuiApp({
      terminal: term,
      onQuery: () => {},
      statusText: () => "openai/gpt-4o | /home/test/proj",
      footerStats: () => null,
    });
    const lines = app["footer"].render(80).join("");
    expect(lines).toContain("openai/gpt-4o");
    expect(lines).not.toContain("↑");
    expect(lines).not.toContain("$");
  });

  it("上下文占用 >90% 红色、>70% 黄色", () => {
    const term = new FakeTerminal();
    const app = new TuiApp({
      terminal: term,
      onQuery: () => {},
      statusText: () => "openai/gpt-4o | /home/test/proj",
      footerStats: () => ({
        totals: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, cost: 0 },
        context: { tokens: 950000, percent: 95, contextWindow: 1000000 },
        branch: null,
      }),
    });
    const lines = app["footer"].render(80).join("");
    expect(lines).toContain(theme.getFgAnsi("error"));
    expect(lines).toContain("95.0%/1.0M");
  });

  it("setWorking(true) 显示 spinner 帧，false 后消失", () => {
    const term = new FakeTerminal();
    const app = new TuiApp({ terminal: term, onQuery: () => {} });
    const footer = app["footer"];
    expect(footer.isWorking()).toBe(false);
    app.setWorking(true, "Working…");
    expect(footer.isWorking()).toBe(true);
    expect(footer.render(80).join("")).toContain("Working…");
    app.setWorking(false);
    expect(footer.isWorking()).toBe(false);
    expect(footer.render(80).join("")).not.toContain("Working…");
  });

  it("提交查询时自动进入 Working，完成后复位", async () => {
    const term = new FakeTerminal();
    let resolveQuery: () => void = () => {};
    const app = new TuiApp({
      terminal: term,
      onQuery: () =>
        new Promise<void>((resolve) => {
          resolveQuery = resolve;
        }),
    });
    app.tui.start();
    try {
      app.editor.setText("问题");
      app.editor.onSubmit?.("问题");
      await new Promise((r) => setTimeout(r, 10));
      expect(app["footer"].isWorking()).toBe(true);
      resolveQuery();
      await new Promise((r) => setTimeout(r, 10));
      expect(app["footer"].isWorking()).toBe(false);
    } finally {
      app.stop();
    }
  });
});
