/**
 * thinking.test.ts — 思考强度切换（回归：无设置入口）
 *
 * 症状：模型可切换但思考强度无法设置（client.ts 支持 thinkingLevel
 * 参数却无任何调用方/UI 入口）。
 * 对齐 pi：Shift+Tab 循环强度（app.thinking.cycle），/thinking 显式设置。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TuiApp } from "./app.ts";
import type { Terminal } from "@earendil-works/pi-tui";
import { resetClient } from "../client.ts";
import {
  setModelRuntimeOverride,
  resetAiRuntime,
  setThinkingLevel,
  getThinkingLevel,
  setCurrentModel,
} from "../ai-runtime.ts";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";

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

const nextTick = () => new Promise<void>((r) => setTimeout(r, 30));

function makeModel(id: string, reasoning: boolean): Model<Api> {
  return {
    provider: "openai",
    id,
    name: id,
    api: "openai-completions",
    ...(reasoning ? { reasoning: { thinkingLevels: ["off", "low", "medium", "high"] } } : {}),
  } as unknown as Model<Api>;
}

function stubRuntime(model: Model<Api>) {
  const stub = {
    getAvailableSnapshot: () => (model ? [model] : []),
    getModel: (provider: string, id: string) =>
      model && model.provider === provider && model.id === id ? model : undefined,
  } as unknown as ModelRuntime;
  setModelRuntimeOverride(stub);
  setCurrentModel(model); // cycle/clamp 依赖 ai-runtime 的当前模型
}

describe("思考强度（回归：无切换入口）", () => {
  beforeEach(() => {
    resetClient();
    setThinkingLevel("off");
  });

  afterEach(() => {
    resetAiRuntime();
    resetClient();
  });

  it("Shift+Tab 循环思考强度（off→low→medium→high→off）", async () => {
    stubRuntime(makeModel("gpt-reason", true));
    const term = new FakeTerminal();
    const app = new TuiApp({ terminal: term, onQuery: () => {} });
    app.tui.start();
    try {
      term.onInput?.("\x1b[Z"); // Shift+Tab
      await nextTick();
      expect(getThinkingLevel()).toBe("low");
      expect(app.getChatText()).toContain("Thinking level: low");
      term.onInput?.("\x1b[Z");
      await nextTick();
      expect(getThinkingLevel()).toBe("medium");
      term.onInput?.("\x1b[Z");
      await nextTick();
      expect(getThinkingLevel()).toBe("high");
      term.onInput?.("\x1b[Z");
      await nextTick();
      expect(getThinkingLevel()).toBe("off"); // 循环回 off
    } finally {
      app.stop();
    }
  });

  it("/thinking <level> 显式设置", async () => {
    stubRuntime(makeModel("gpt-reason", true));
    const term = new FakeTerminal();
    const app = new TuiApp({ terminal: term, onQuery: () => {} });
    app.tui.start();
    try {
      app.editor.onSubmit?.("/thinking high");
      await nextTick();
      expect(getThinkingLevel()).toBe("high");
      expect(app.getChatText()).toContain("Thinking level: high");
      app.editor.onSubmit?.("/thinking off");
      await nextTick();
      expect(getThinkingLevel()).toBe("off");
    } finally {
      app.stop();
    }
  });

  it("/thinking 无参数显示当前级别与可用级别", async () => {
    stubRuntime(makeModel("gpt-reason", true));
    setThinkingLevel("medium");
    const term = new FakeTerminal();
    const app = new TuiApp({ terminal: term, onQuery: () => {} });
    app.tui.start();
    try {
      app.editor.onSubmit?.("/thinking");
      await nextTick();
      expect(app.getChatText()).toContain("medium");
      expect(app.getChatText()).toContain("可用");
    } finally {
      app.stop();
    }
  });

  it("/thinking <非法值> 提示合法级别", async () => {
    stubRuntime(makeModel("gpt-reason", true));
    const term = new FakeTerminal();
    const app = new TuiApp({ terminal: term, onQuery: () => {} });
    app.tui.start();
    try {
      app.editor.onSubmit?.("/thinking turbo");
      await nextTick();
      expect(getThinkingLevel()).toBe("off");
      expect(app.getChatText()).toContain("未知级别");
    } finally {
      app.stop();
    }
  });

  it("模型不支持思考时提示", async () => {
    stubRuntime(makeModel("gpt-plain", false));
    const term = new FakeTerminal();
    const app = new TuiApp({ terminal: term, onQuery: () => {} });
    app.tui.start();
    try {
      term.onInput?.("\x1b[Z");
      await nextTick();
      expect(app.getChatText()).toContain("不支持");
    } finally {
      app.stop();
    }
  });

  it("启动帮助包含 Shift+Tab 与 /thinking 选项", () => {
    const term = new FakeTerminal();
    const app = new TuiApp({
      terminal: term,
      onQuery: () => {},
      initialText: "claude-pi — 输入 /help 查看命令\n\n",
    });
    app.tui.start();
    try {
      const startup = app["startupMessage"] as { setExpanded(b: boolean): void };
      startup.setExpanded(true); // 命令/键位清单在展开态
      app.chat.setViewportHeight(100); // 展开内容超默认视口，避免截断
      const lines = app.chat.render(80).join("");
      expect(lines).toContain("Shift+Tab");
      expect(lines).toContain("/thinking");
    } finally {
      app.stop();
    }
  });
});
