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
  it("显示 claude-pi · 模型 · cwd，主题着色", () => {
    const term = new FakeTerminal();
    const app = new TuiApp({
      terminal: term,
      onQuery: () => {},
      statusText: () => "openai/gpt-4o | /home/test/proj",
    });
    const lines = app["footer"].render(80).join("");
    expect(lines).toContain("claude-pi");
    expect(lines).toContain(theme.getFgAnsi("accent"));
    expect(lines).toContain("openai/gpt-4o");
    expect(lines).toContain("/home/test/proj");
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
