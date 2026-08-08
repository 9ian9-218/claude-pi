import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TuiApp } from "./app.ts";
import { MockOpenAI } from "../../tests/helpers/mock-openai.ts";
import { installMockModels } from "../../tests/helpers/test-client.ts";
import { resetClient } from "../client.ts";
import { agentLoop } from "../agent-loop.ts";
import { LoopOptions } from "../loop-options.ts";
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

const nextTick = () => new Promise<void>((r) => setTimeout(r, 20));

let mock: MockOpenAI;

beforeEach(async () => {
  resetClient();
  mock = await MockOpenAI.create();
  installMockModels(mock.baseUrl);
});

afterEach(async () => {
  resetClient();
  await mock.close();
});

describe("Esc 中断（08）", () => {
  it("busy 时 Esc 触发 AbortController（handleSubmit 挂起期间）", async () => {
    const term = new FakeTerminal();
    let release: () => void = () => {};
    const app = new TuiApp({
      terminal: term,
      onQuery: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    app.tui.start();
    try {
      app.editor.setText("问题");
      app.editor.onSubmit?.("问题");
      await nextTick();
      expect(app["turns"].isBusy()).toBe(true);
      term.onInput?.("\x1b"); // Esc
      expect(app.getTurnSignal()?.aborted).toBe(true);
      release();
      await nextTick();
      expect(app["turns"].isBusy()).toBe(false);
    } finally {
      app.stop();
    }
  });

  it("空闲时 Esc 无副作用（不 abort、不退出）", async () => {
    const term = new FakeTerminal();
    const app = new TuiApp({ terminal: term, onQuery: () => {} });
    app.tui.start();
    try {
      term.onInput?.("\x1b");
      expect(app.isRunning()).toBe(true);
      expect(app.getTurnSignal()).toBeNull();
    } finally {
      app.stop();
    }
  });

  it("finishAssistantTurn(aborted) 在助手块底部显示 Operation aborted", () => {
    const term = new FakeTerminal();
    const app = new TuiApp({ terminal: term, onQuery: () => {} });
    app.beginAssistantTurn();
    app.appendStream("部分内容");
    app.finishAssistantTurn({ stopReason: "aborted" });
    const lines = app.chat.render(80).join("");
    expect(lines).toContain("部分内容");
    expect(lines).toContain("Operation aborted");
  });

  it("全链路：预置 aborted signal 时 loop 不落 [Error] 且广播中止态", async () => {
    mock.always(() => ({ kind: "sse", chunks: [{ content: "hi", finishReason: "stop" }] }));
    const term = new FakeTerminal();
    const app = new TuiApp({ terminal: term, onQuery: () => {} });
    const controller = new AbortController();
    controller.abort();
    const turns: Array<{ stopReason?: string }> = [];
    app.beginAssistantTurn();
    const messages = [{ role: "user" as const, content: "go" }];
    try {
      const result = await agentLoop(messages, {
        loopOptions: new LoopOptions({
          quietOutput: true,
          signal: controller.signal,
          onTurnEnd: (e) => {
            turns.push(e);
            app.finishAssistantTurn(e);
          },
        }),
      });
      expect(result).toBeNull();
      expect(turns.length).toBeGreaterThanOrEqual(1);
      expect(turns[0].stopReason).toBe("aborted");
      // 无脏数据
      expect(messages.some((m) => String(m.content ?? "").includes("[Error]"))).toBe(false);
      const lines = app.chat.render(80).join("");
      expect(lines).toContain("Operation aborted");
    } finally {
      app.endAssistantTurn();
    }
  });
});
