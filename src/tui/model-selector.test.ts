import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TuiApp } from "./app.ts";
import { makeCompletionsModel } from "../../tests/helpers/test-client.ts";
import { resetClient } from "../client.ts";
import { setModelRuntimeOverride, currentModelLabel } from "../ai-runtime.ts";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Api } from "@earendil-works/pi-ai";
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

const nextTick = () => new Promise<void>((r) => setTimeout(r, 30));

describe("模型选择器（09）", () => {
  beforeEach(() => {
    resetClient();
  });

  afterEach(() => {
    resetClient();
  });

  it("Ctrl+L 弹出模型列表，回车切换当前模型", async () => {
    const modelA = makeCompletionsModel("gpt-test", "http://localhost:9");
    const modelB = makeCompletionsModel("gpt-big", "http://localhost:9");
    const stub = {
      getAvailableSnapshot: () => [modelA, modelB],
      getModel: (provider: string, id: string) =>
        [modelA, modelB].find((m) => m.provider === provider && m.id === id),
    } as unknown as ModelRuntime;
    setModelRuntimeOverride(stub);

    const term = new FakeTerminal();
    const app = new TuiApp({ terminal: term, onQuery: () => {} });
    app.tui.start();
    try {
      term.onInput?.("\x0c"); // Ctrl+L
      await nextTick();
      const overlayShown = term.writes.join("").length > 0;
      expect(overlayShown).toBe(true);
      // 选择第二项（gpt-big）并回车
      term.onInput?.("\x1b[B");
      term.onInput?.("\r");
      await nextTick();
      expect(currentModelLabel()).toBe("openai/gpt-big");
      expect(app.getChatText()).toContain("已切换模型");
    } finally {
      app.stop();
    }
  });

  it("无可用模型时提示 warning", async () => {
    const stub = {
      getAvailableSnapshot: () => [],
    } as unknown as ModelRuntime;
    setModelRuntimeOverride(stub);
    const term = new FakeTerminal();
    const app = new TuiApp({ terminal: term, onQuery: () => {} });
    app.tui.start();
    try {
      term.onInput?.("\x0c");
      await nextTick();
      expect(app.getChatText()).toContain("无可用模型");
    } finally {
      app.stop();
    }
  });
});
