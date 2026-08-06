import { describe, it, expect } from "vitest";
import { TuiApp } from "./app.ts";
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

const nextTick = () => new Promise<void>((r) => setTimeout(r, 50));

describe("Editor 输入框（06）", () => {
  it("Ctrl+C 清空输入框（对齐 pi app.clear）", async () => {
    const term = new FakeTerminal();
    const app = new TuiApp({ terminal: term, onQuery: () => {} });
    app.tui.start();
    try {
      app.editor.setText("正在输入的内容");
      term.onInput?.("\x03"); // Ctrl+C
      expect(app.editor.getText()).toBe("");
    } finally {
      app.stop();
    }
  });

  it("Ctrl+D 空输入时退出（对齐 pi app.exit）", async () => {
    const term = new FakeTerminal();
    const app = new TuiApp({ terminal: term, onQuery: () => {} });
    app.tui.start();
    try {
      expect(app.isRunning()).toBe(true);
      term.onInput?.("\x04"); // Ctrl+D
      expect(app.isRunning()).toBe(false);
    } finally {
      app.stop();
    }
  });

  it("Ctrl+D 非空时不退出（交给编辑器删除字符）", async () => {
    const term = new FakeTerminal();
    const app = new TuiApp({ terminal: term, onQuery: () => {} });
    app.tui.start();
    try {
      app.editor.setText("abc");
      app.editor.handleInput("\x1b[D"); // 光标左移一位
      term.onInput?.("\x04"); // Ctrl+D → deleteCharForward
      expect(app.isRunning()).toBe(true);
      expect(app.editor.getText()).toBe("ab");
    } finally {
      app.stop();
    }
  });

  it("输入 / 弹出命令自动补全列表", async () => {
    const term = new FakeTerminal();
    const app = new TuiApp({ terminal: term, onQuery: () => {} });
    app.tui.start();
    try {
      // 逐字符键入（光标跟随），触发斜杠命令补全
      app.editor.handleInput("/");
      app.editor.handleInput("h");
      await new Promise((r) => setTimeout(r, 300));
      const rendered = app.editor.render(80).join("");
      expect(rendered).toContain("help");
      expect(rendered).toContain("显示帮助");
    } finally {
      app.stop();
    }
  });

  it("提交后历史可上下翻阅", async () => {
    const term = new FakeTerminal();
    const app = new TuiApp({ terminal: term, onQuery: () => {} });
    app.tui.start();
    try {
      app.editor.setText("第一条问题");
      app.editor.onSubmit?.("第一条问题");
      app.editor.addToHistory("第一条问题");
      // 上箭头翻历史（第一行 + 空输入时）
      app.editor.handleInput("\x1b[A");
      expect(app.editor.getText()).toBe("第一条问题");
    } finally {
      app.stop();
    }
  });
});
