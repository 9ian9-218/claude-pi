import { describe, it, expect } from "vitest";
import { TuiApp } from "./app.ts";
import { AssistantMessageComponent } from "./messages/assistant-message.ts";
import { UserMessageComponent } from "./messages/user-message.ts";
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

const OSC133_START = "\x1b]133;A\x07";
const OSC133_END = "\x1b]133;B\x07\x1b]133;C\x07";

describe("thinking 块（05）", () => {
  it("thinking 增量渲染为斜体灰字，位于正文之前", () => {
    const c = new AssistantMessageComponent();
    c.appendThinking("让我想想");
    c.appendDelta("答案在此");
    const lines = c.render(80).join("");
    expect(lines).toContain(theme.getFgAnsi("thinkingText"));
    expect(lines).toContain("让我想想");
    expect(lines).toContain("答案在此");
    expect(lines.indexOf("让我想想")).toBeLessThan(lines.indexOf("答案在此"));
    expect(c.getText()).toBe("让我想想\n答案在此");
  });

  it("Ctrl+T 折叠为 Thinking… 标签，再按展开", () => {
    const term = new FakeTerminal();
    const app = new TuiApp({ terminal: term, onQuery: () => {} });
    app.tui.start();
    try {
      app.beginAssistantTurn();
      app.appendThinking("推理内容");
      app.appendStream("正文");
      expect(app.chat.render(80).join("")).toContain("推理内容");
      term.onInput?.("\x14"); // Ctrl+T 折叠
      const collapsed = app.chat.render(80).join("");
      expect(collapsed).not.toContain("推理内容");
      expect(collapsed).toContain("Thinking…");
      term.onInput?.("\x14"); // 再按展开
      expect(app.chat.render(80).join("")).toContain("推理内容");
    } finally {
      app.stop();
    }
  });

  it("无 thinking 时 Ctrl+T 无副作用", () => {
    const term = new FakeTerminal();
    const app = new TuiApp({ terminal: term, onQuery: () => {} });
    app.tui.start();
    try {
      app.beginAssistantTurn();
      app.appendStream("正文");
      term.onInput?.("\x14");
      expect(app.chat.render(80).join("")).toContain("正文");
    } finally {
      app.stop();
    }
  });
});

describe("OSC133 终端跳转标记（05）", () => {
  it("用户消息块首尾包 OSC133 标记", () => {
    const c = new UserMessageComponent("问题");
    const lines = c.render(80);
    console.log("DBG:", JSON.stringify(lines));
    expect(lines[0].startsWith(OSC133_START)).toBe(true);
    expect(lines[lines.length - 1].endsWith(OSC133_END)).toBe(true);
  });

  it("助手消息块首尾包 OSC133 标记", () => {
    const c = new AssistantMessageComponent();
    c.appendDelta("回答");
    const lines = c.render(80);
    expect(lines[0].startsWith(OSC133_START)).toBe(true);
    expect(lines[lines.length - 1]).toContain(OSC133_END);
  });

  it("空助手块无标记", () => {
    const c = new AssistantMessageComponent();
    expect(c.render(80)).toHaveLength(0);
  });
});

describe("PgUp/PgDn 滚动（05）", () => {
  it("消息超出视口时 PgUp 上翻、PgDn 回底", () => {
    const term = new FakeTerminal();
    const app = new TuiApp({ terminal: term, onQuery: () => {} });
    app.tui.start();
    try {
      // 制造超出视口（24 行终端 → 视口 21）的内容
      for (let i = 0; i < 30; i++) {
        app.appendSystem(`消息${i}`);
      }
      const bottom = app.chat.render(80).join("");
      expect(bottom).toContain("消息29");
      expect(bottom).not.toContain("消息0");
      term.onInput?.("\x1b[5~"); // PgUp
      expect(app.chat.isScrolledUp()).toBe(true);
      const scrolled = app.chat.render(80).join("");
      expect(scrolled).toContain("消息0");
      term.onInput?.("\x1b[6~"); // PgDn
      expect(app.chat.isScrolledUp()).toBe(false);
      expect(app.chat.render(80).join("")).toContain("消息29");
    } finally {
      app.stop();
    }
  });
});
