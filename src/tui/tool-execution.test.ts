import { describe, it, expect } from "vitest";
import { TuiApp } from "./app.ts";
import { ToolExecutionComponent } from "./messages/tool-execution.ts";
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

describe("ToolExecutionComponent（04）", () => {
  it("pending：灰底 + 工具名 + 参数", () => {
    const c = new ToolExecutionComponent("bash", "call_1", { command: "ls" });
    const lines = c.render(80).join("");
    expect(lines).toContain(theme.getBgAnsi("toolPendingBg"));
    expect(lines).toContain("bash");
    expect(lines).toContain("ls");
  });

  it("result 成功：绿底 + 结果", () => {
    const c = new ToolExecutionComponent("bash", "call_1", { command: "ls" });
    c.updateResult("file1\nfile2", false);
    const lines = c.render(80).join("");
    expect(lines).toContain(theme.getBgAnsi("toolSuccessBg"));
    expect(lines).not.toContain(theme.getBgAnsi("toolPendingBg"));
    expect(lines).toContain("file1");
  });

  it("result 错误：红底", () => {
    const c = new ToolExecutionComponent("bash", "call_1", {});
    c.updateResult("command not found", true);
    const lines = c.render(80).join("");
    expect(lines).toContain(theme.getBgAnsi("toolErrorBg"));
  });

  it("超长输出折叠：尾部若干行 + 折叠提示；展开后全文", () => {
    const c = new ToolExecutionComponent("bash", "call_1", {});
    const long = Array.from({ length: 50 }, (_, i) => `line${i}`).join("\n");
    c.updateResult(long, false);
    const collapsed = c.render(80).join("");
    expect(collapsed).toContain("已折叠");
    expect(collapsed).toContain("line49");
    expect(collapsed).not.toContain("line0");
    c.setExpanded(true);
    const expanded = c.render(80).join("");
    expect(expanded).toContain("line0");
    expect(expanded).toContain("line49");
    expect(expanded).not.toContain("已折叠");
  });

  it("短输出不折叠、无提示", () => {
    const c = new ToolExecutionComponent("read", "call_2", { path: "a.txt" });
    c.updateResult("short", false);
    const lines = c.render(80).join("");
    expect(lines).not.toContain("已折叠");
  });
});

describe("TuiApp 工具事件接线（04）", () => {
  it("handleToolEvent start→result 三态流转", () => {
    const term = new FakeTerminal();
    const app = new TuiApp({ terminal: term, onQuery: () => {} });
    app.handleToolEvent({ phase: "start", name: "bash", id: "call_1", args: { command: "ls" } });
    let lines = app.chat.render(80).join("");
    expect(lines).toContain(theme.getBgAnsi("toolPendingBg"));
    app.handleToolEvent({
      phase: "result",
      name: "bash",
      id: "call_1",
      args: { command: "ls" },
      result: "ok",
      isError: false,
    });
    lines = app.chat.render(80).join("");
    expect(lines).toContain(theme.getBgAnsi("toolSuccessBg"));
    expect(app.getChatText()).toContain("ok");
  });

  it("Ctrl+O 切换全部工具块展开/折叠", () => {
    const term = new FakeTerminal();
    const app = new TuiApp({ terminal: term, onQuery: () => {} });
    app.tui.start();
    try {
      app.handleToolEvent({ phase: "start", name: "bash", id: "call_1", args: {} });
      app.handleToolEvent({
        phase: "result",
        name: "bash",
        id: "call_1",
        args: {},
        result: Array.from({ length: 40 }, (_, i) => `r${i}`).join("\n"),
        isError: false,
      });
      expect(app.getToolOutputExpanded()).toBe(false);
      term.onInput?.("\x0f"); // Ctrl+O
      expect(app.getToolOutputExpanded()).toBe(true);
      const component = app.chat.children[0] as ToolExecutionComponent;
      const expanded = component.render(80).join("");
      expect(expanded).toContain("r0");
      expect(expanded).not.toContain("已折叠");
      term.onInput?.("\x0f");
      expect(app.getToolOutputExpanded()).toBe(false);
      const collapsed = component.render(80).join("");
      expect(collapsed).not.toContain("r0");
      expect(collapsed).toContain("已折叠");
    } finally {
      app.stop();
    }
  });
});
