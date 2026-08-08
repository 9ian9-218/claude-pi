import { describe, it, expect } from "vitest";
import { TuiApp } from "./app.ts";
import { MessageList } from "./messages/message-list.ts";
import { UserMessageComponent } from "./messages/user-message.ts";
import { SystemMessageComponent } from "./messages/system-message.ts";
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

const nextTick = () => new Promise<void>((r) => setTimeout(r, 10));

describe("MessageList（03，替代 Scrollback）", () => {
  it("视口截取：超过高度时从底部显示", () => {
    const list = new MessageList();
    list.setViewportHeight(3);
    for (const t of ["line1", "line2", "line3", "line4", "line5"]) {
      list.addChild(new SystemMessageComponent(t));
    }
    const lines = list.render(80);
    expect(lines.length).toBe(3);
    expect(lines.join("")).toContain("line3");
    expect(lines.join("")).toContain("line5");
    expect(lines.join("")).not.toContain("line1");
  });

  it("scrollUp/scrollDown 调整偏移", () => {
    const list = new MessageList();
    list.setViewportHeight(2);
    for (const t of ["a", "b", "c", "d"]) {
      list.addChild(new SystemMessageComponent(t));
    }
    list.scrollUp();
    const up = list.render(80).join("");
    expect(up).toContain("b");
    expect(up).toContain("c");
    list.scrollDown();
    const down = list.render(80).join("");
    expect(down).toContain("c");
    expect(down).toContain("d");
  });

  it("上翻后追加新消息不打断位置；scrollToBottom 回到底部", () => {
    const list = new MessageList();
    list.setViewportHeight(2);
    for (const t of ["a", "b", "c"]) {
      list.addChild(new SystemMessageComponent(t));
    }
    list.scrollUp();
    list.scrollUp();
    list.addChild(new SystemMessageComponent("d"));
    // 上翻位置保持：仍看到 b/c
    const stayed = list.render(80).join("");
    expect(stayed).toContain("b");
    expect(stayed).toContain("c");
    expect(stayed).not.toContain("d");
    list.scrollToBottom();
    const bottom = list.render(80).join("");
    expect(bottom).toContain("c");
    expect(bottom).toContain("d");
  });
});

describe("TuiApp（S14 重构）", () => {
  it("Input 提交触发 onQuery，输入清空", async () => {
    const queries: string[] = [];
    const term = new FakeTerminal();
    const app = new TuiApp({
      terminal: term,
      onQuery: (q) => {
        queries.push(q);
      },
    });
    app.editor.setText("你好世界");
    app.editor.onSubmit?.("你好世界");
    await nextTick();
    expect(queries).toEqual(["你好世界"]);
    expect(app.editor.getText()).toBe("");
  });

  it("斜杠命令分发：/new 触发 onNewSession 并清空聊天区", async () => {
    let newCount = 0;
    const term = new FakeTerminal();
    const app = new TuiApp({
      terminal: term,
      onQuery: () => {},
      onNewSession: () => {
        newCount += 1;
      },
    });
    app.appendMessage("user", "旧内容");
    app.editor.onSubmit?.("/new");
    await nextTick();
    expect(newCount).toBe(1);
    expect(app.getChatText()).not.toContain("旧内容");
  });

  it("/help 显示帮助到聊天区", async () => {
    const term = new FakeTerminal();
    const app = new TuiApp({ terminal: term, onQuery: () => {} });
    app.editor.onSubmit?.("/help");
    await nextTick();
    expect(app.getChatText()).toContain("/new 开新会话");
  });

  it("未知命令提示", async () => {
    const term = new FakeTerminal();
    const app = new TuiApp({ terminal: term, onQuery: () => {} });
    app.editor.onSubmit?.("/nope");
    await nextTick();
    expect(app.getChatText()).toContain("未知命令");
  });

  it("用户消息渲染为背景块，无角色前缀", () => {
    const term = new FakeTerminal();
    const app = new TuiApp({ terminal: term, onQuery: () => {} });
    app.appendMessage("user", "问题");
    const lines = app.chat.render(80);
    expect(lines.join("")).toContain(theme.getBgAnsi("userMessageBg"));
    expect(lines.join("")).toContain("问题");
    expect(app.getChatText()).not.toContain("User >");
    expect(app.getChatText()).not.toContain("Model >");
    expect(app.getChatText()).not.toContain("user >");
  });

  it("流式助手消息无前缀、增量合并到同一块", async () => {
    const term = new FakeTerminal();
    const app = new TuiApp({ terminal: term, onQuery: () => {} });
    app.beginAssistantTurn();
    app.appendStream("你");
    app.appendStream("好");
    app.endAssistantTurn();
    const text = app.getChatText();
    expect(text).toBe("你好");
    expect(text).not.toContain("Model >");
    const lines = app.chat.render(80);
    // 助手块非背景块（与用户块区分）
    expect(lines.join("")).not.toContain(theme.getBgAnsi("userMessageBg"));
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
    app.editor.onSubmit?.("/help"); // 命令不置 busy
    app["busy"] = true;
    app.editor.onSubmit?.("第二条");
    await nextTick();
    expect(calls).toBe(0);
  });
});

describe("TuiApp + agentLoop 流式集成（S14）", () => {
  it("onStream 流式内容进助手块", async () => {
    const { MockOpenAI } = await import("../../tests/helpers/mock-openai.ts");
    const { installMockModels } = await import("../../tests/helpers/test-client.ts");
    const { resetClient } = await import("../client.ts");
    const { agentLoop } = await import("../agent-loop.ts");
    const { LoopOptions } = await import("../loop-options.ts");
    const { SessionManager, setSessionRoot } = await import("../session-manager.ts");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");

    resetClient();
    const mock = await MockOpenAI.create();
    installMockModels(mock.baseUrl);
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
      app.beginAssistantTurn();
      try {
        await agentLoop(session.buildSessionContext().messages, {
          session,
          loopOptions: new LoopOptions({
            quietOutput: true,
            onStream: (d) => {
              if (d.kind === "text") app.appendStream(d.delta);
            },
          }),
        });
      } finally {
        app.endAssistantTurn();
      }
      expect(app.getChatText()).toContain("流式回复");
    } finally {
      await mock.close();
      fs.rmSync(sessDir, { recursive: true, force: true });
    }
  });
});

describe("权限弹窗（S15a）", () => {
  function makeRequest() {
    return {
      id: "perm-1",
      workerName: "worker-1",
      workerId: "worker-1",
      teamName: "t1",
      toolName: "run_bash",
      toolUseId: "call_1",
      description: "Potentially destructive command",
      input: { command: "rm -rf build" },
      workerColor: "green",
      status: "pending" as const,
      createdAt: Date.now(),
    };
  }

  it("回车选择允许 → approved", async () => {
    const term = new FakeTerminal();
    const app = new TuiApp({ terminal: term, onQuery: () => {} });
    app.tui.start();
    const promise = app.askPermission(makeRequest(), "Teammate [worker-1]");
    await nextTick();
    // SelectList 默认选中第一项（允许）→ 回车
    term.onInput?.("\r");
    const resolution = await promise;
    expect(resolution.decision).toBe("approved");
    app.stop();
  });

  it("向下 + 回车选择拒绝 → rejected", async () => {
    const term = new FakeTerminal();
    const app = new TuiApp({ terminal: term, onQuery: () => {} });
    app.tui.start();
    const promise = app.askPermission(makeRequest(), "Lead");
    await nextTick();
    term.onInput?.("\x1b[B"); // 向下
    term.onInput?.("\r"); // 回车
    const resolution = await promise;
    expect(resolution.decision).toBe("rejected");
    expect(resolution.feedback).toContain("Permission denied");
    app.stop();
  });
});

describe("通知与状态（S15c）", () => {
  it("队友消息 accent 着色渲染", () => {
    const term = new FakeTerminal();
    const app = new TuiApp({ terminal: term, onQuery: () => {} });
    app.appendMessage(
      "user",
      '<teammate-message teammate_id="worker-1" color="green">\n进度报告\n</teammate-message>',
    );
    const lines = app.chat.render(80).join("");
    expect(lines).toContain(theme.getFgAnsi("accent"));
    expect(lines).toContain("进度报告");
  });

  it("后台任务通知 success 着色渲染", () => {
    const term = new FakeTerminal();
    const app = new TuiApp({ terminal: term, onQuery: () => {} });
    app.appendMessage("user", "<task_notification>\n<status>completed</status>\n</task_notification>");
    const lines = app.chat.render(80).join("");
    expect(lines).toContain(theme.getFgAnsi("success"));
    expect(lines).toContain("completed");
  });
});

describe("TUI 渲染树挂载（回归）", () => {
  it("root 挂在 TUI 上：渲染输出包含聊天区与编辑器", () => {
    const term = new FakeTerminal();
    const app = new TuiApp({
      terminal: term,
      onQuery: () => {},
      initialText: "启动文本-REG",
    });
    app.tui.start();
    try {
      const lines = app.tui.render(80).join("");
      // 聊天区（startup message）在渲染树中
      expect(lines).toContain("启动文本-REG");
      // 编辑器边框（borderColor 渲染）在渲染树中
      expect(lines).toContain("─");
    } finally {
      app.stop();
    }
  });
});
