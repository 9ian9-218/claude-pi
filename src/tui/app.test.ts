import { describe, it, expect } from "vitest";
import { TuiApp } from "./app.ts";
import { Scrollback } from "./scrollback.ts";
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

const nextTick = () => new Promise<void>((r) => setTimeout(r, 10));

describe("Scrollback（S14）", () => {
  it("视口截取：超过高度时从底部显示", () => {
    const sb = new Scrollback();
    sb.setViewportHeight(3);
    sb.append("line1\nline2\nline3\nline4\nline5");
    const lines = sb.render(80);
    expect(lines.length).toBe(3);
    expect(lines.join("")).toContain("line3");
    expect(lines.join("")).toContain("line5");
    expect(lines.join("")).not.toContain("line1");
  });

  it("scrollUp/scrollDown 调整偏移", () => {
    const sb = new Scrollback();
    sb.setViewportHeight(2);
    sb.append("a\nb\nc\nd");
    sb.scrollUp();
    const up = sb.render(80).join("");
    expect(up).toContain("b");
    expect(up).toContain("c");
    sb.scrollDown();
    const down = sb.render(80).join("");
    expect(down).toContain("c");
    expect(down).toContain("d");
  });

  it("append 自动滚到底部", () => {
    const sb = new Scrollback();
    sb.setViewportHeight(2);
    sb.append("a\nb\nc");
    sb.scrollUp();
    sb.append("d");
    const lines = sb.render(80).join("");
    expect(lines).toContain("c");
    expect(lines).toContain("d");
  });
});

describe("TuiApp（S14）", () => {
  it("Input 提交触发 onQuery，输入清空", async () => {
    const queries: string[] = [];
    const term = new FakeTerminal();
    const app = new TuiApp({
      terminal: term,
      onQuery: (q) => {
        queries.push(q);
      },
    });
    app.input.setValue("你好世界");
    app.input.onSubmit?.("你好世界");
    await nextTick();
    expect(queries).toEqual(["你好世界"]);
    expect(app.input.getValue()).toBe("");
  });

  it("斜杠命令分发：/new 触发 onNewSession 并清空滚动区", async () => {
    let newCount = 0;
    const term = new FakeTerminal();
    const app = new TuiApp({
      terminal: term,
      onQuery: () => {},
      onNewSession: () => {
        newCount += 1;
      },
    });
    app.scrollback.append("旧内容");
    app.input.onSubmit?.("/new");
    await nextTick();
    expect(newCount).toBe(1);
    expect(app.scrollback.getText()).not.toContain("旧内容");
  });

  it("/help 显示帮助到滚动区", async () => {
    const term = new FakeTerminal();
    const app = new TuiApp({ terminal: term, onQuery: () => {} });
    app.input.onSubmit?.("/help");
    await nextTick();
    expect(app.scrollback.getText()).toContain("/new 开新会话");
  });

  it("未知命令提示", async () => {
    const term = new FakeTerminal();
    const app = new TuiApp({ terminal: term, onQuery: () => {} });
    app.input.onSubmit?.("/nope");
    await nextTick();
    expect(app.scrollback.getText()).toContain("未知命令");
  });

  it("appendMessage 带角色标签渲染", () => {
    const term = new FakeTerminal();
    const app = new TuiApp({ terminal: term, onQuery: () => {} });
    app.appendMessage("user", "问题");
    app.appendMessage("assistant", "回答");
    const text = app.scrollback.getText();
    expect(text).toContain("User >");
    expect(text).toContain("Model >");
  });

  it("busy 期间忽略提交", async () => {
    const term = new FakeTerminal();
    let calls = 0;
    const app = new TuiApp({
      terminal: term,
      onQuery: () => {
        calls += 1;
      },
    });
    app.input.onSubmit?.("/help"); // 命令不置 busy
    app["busy"] = true;
    app.input.onSubmit?.("第二条");
    await nextTick();
    expect(calls).toBe(0);
  });
});

describe("TuiApp + agentLoop 流式集成（S14）", () => {
  it("onStream 流式内容进滚动区", async () => {
    const { MockOpenAI } = await import("../../tests/helpers/mock-openai.ts");
    const { resetClient } = await import("../client.ts");
    const { agentLoop } = await import("../agent-loop.ts");
    const { LoopOptions } = await import("../loop-options.ts");
    const { SessionManager, setSessionRoot } = await import("../session-manager.ts");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");

    const originalEnv = { ...process.env };
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_MODEL = "gpt-test";
    resetClient();
    const mock = await MockOpenAI.create();
    process.env.OPENAI_BASE_URL = mock.baseUrl;
    const sessDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pi-tui-"));
    setSessionRoot(sessDir);
    try {
      mock.always(() => ({
        kind: "sse",
        chunks: [{ content: "流式" }, { content: "回复", finishReason: "stop" }],
      }));
      const term = new FakeTerminal();
      const app = new TuiApp({ terminal: term, onQuery: () => {} });
      const session = SessionManager.create(process.cwd());
      session.appendMessage({ role: "user", content: "测试" });
      await agentLoop(session.buildSessionContext().messages, {
        session,
        loopOptions: new LoopOptions({
          quietOutput: true,
          onStream: (t) => app.appendStream(t),
        }),
      });
      expect(app.scrollback.getText()).toContain("流式回复");
    } finally {
      process.env = originalEnv;
      await mock.close();
      fs.rmSync(sessDir, { recursive: true, force: true });
    }
  });
});
