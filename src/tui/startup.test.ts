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

describe("启动屏/欢迎页（10）", () => {
  it("启动显示折叠帮助一行，Ctrl+O 展开完整帮助", () => {
    const term = new FakeTerminal();
    const app = new TuiApp({
      terminal: term,
      onQuery: () => {},
      initialText: "claude-pi — 输入 /help 查看命令",
    });
    app.tui.start();
    try {
      const collapsed = app.chat.render(80).join("");
      expect(collapsed).toContain("输入 /help 查看命令");
      expect(collapsed).not.toContain("Ctrl+L");
      term.onInput?.("\x0f"); // Ctrl+O
      const expanded = app.chat.render(80).join("");
      expect(expanded).toContain("Ctrl+L 模型选择器");
      expect(expanded).toContain("/tree 会话树导航");
      term.onInput?.("\x0f"); // 再按折叠
      expect(app.chat.render(80).join("")).not.toContain("Ctrl+L 模型选择器");
    } finally {
      app.stop();
    }
  });

  it("/help 展开启动帮助", async () => {
    const term = new FakeTerminal();
    const app = new TuiApp({
      terminal: term,
      onQuery: () => {},
      initialText: "claude-pi v0.1.0",
    });
    app.tui.start();
    try {
      app.editor.handleInput("/help");
      app.editor.onSubmit?.("/help");
      await new Promise((r) => setTimeout(r, 10));
      expect(app.chat.render(80).join("")).toContain("/quit 退出");
    } finally {
      app.stop();
    }
  });

  it("无 initialText 时 /help 走系统消息回退", async () => {
    const term = new FakeTerminal();
    const app = new TuiApp({ terminal: term, onQuery: () => {} });
    app.tui.start();
    try {
      app.editor.onSubmit?.("/help");
      await new Promise((r) => setTimeout(r, 10));
      expect(app.getChatText()).toContain("/new 开新会话");
    } finally {
      app.stop();
    }
  });
});
