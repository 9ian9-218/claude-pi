import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TuiApp } from "./app.ts";
import { ui, setTuiApp, registerEntryRenderer, renderCustomEntry, clearEntryRenderers } from "./ui-provider.ts";
import { Text, type Terminal } from "@earendil-works/pi-tui";

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

let app: TuiApp;
let term: FakeTerminal;

beforeEach(() => {
  term = new FakeTerminal();
  app = new TuiApp({ terminal: term, onQuery: () => {} });
  app.tui.start();
  setTuiApp(app);
  clearEntryRenderers();
});

afterEach(() => {
  setTuiApp(null);
  app.stop();
});

const nextTick = () => new Promise<void>((r) => setTimeout(r, 20));

describe("ctx.ui（S17）", () => {
  it("confirm 回车 → true", async () => {
    const p = ui.confirm("允许?");
    await nextTick();
    term.onInput?.("\r");
    expect(await p).toBe(true);
  });

  it("confirm 向下+回车 → false", async () => {
    const p = ui.confirm("允许?", true);
    await nextTick();
    term.onInput?.("\x1b[B");
    term.onInput?.("\r");
    expect(await p).toBe(false);
  });

  it("select 选择第二项", async () => {
    const p = ui.select(
      [
        { value: "a", label: "选项A" },
        { value: "b", label: "选项B" },
      ],
      "选择",
    );
    await nextTick();
    term.onInput?.("\x1b[B");
    term.onInput?.("\r");
    expect(await p).toBe("b");
  });

  it("input 输入文本提交", async () => {
    const p = ui.input("输入名字");
    await nextTick();
    // 输入字符 + 回车
    for (const ch of "张三") {
      term.onInput?.(ch);
    }
    term.onInput?.("\r");
    expect(await p).toBe("张三");
  });

  it("notify 追加到滚动区", () => {
    ui.notify("扩展通知", { level: "warning" });
    expect(app.getChatText()).toContain("扩展通知");
  });

  it("custom 挂载自定义组件（渲染输出）", () => {
    const component = new Text("自定义组件内容", 0, 0);
    ui.custom(component);
    app.tui.requestRender(true);
  });

  it("registerEntryRenderer 按 customType 渲染", () => {
    registerEntryRenderer("my-stat", (data) => `统计: ${JSON.stringify(data)}`);
    expect(renderCustomEntry("my-stat", { count: 3 })).toBe("统计: {\"count\":3}");
    expect(renderCustomEntry("unknown-type", {})).toBeNull();
  });

  it("非 TUI 模式回退", async () => {
    setTuiApp(null);
    expect(await ui.confirm("x")).toBe(false);
    expect(await ui.select([{ value: "a", label: "A" }], "t")).toBeNull();
    expect(await ui.input("t")).toBeNull();
  });
});
