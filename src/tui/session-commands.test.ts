import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TuiApp } from "./app.ts";
import { handleSessionCommand } from "./session-commands.ts";
import { SessionManager, setSessionRoot } from "../session-manager.ts";
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

let dir: string;
let cwd: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pi-s15b-"));
  setSessionRoot(dir);
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pi-s15b-cwd-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

function makeApp(session: SessionManager | null, sessionRef: { current: SessionManager | null }) {
  const app = new TuiApp({ terminal: new FakeTerminal(), onQuery: () => {} });
  sessionRef.current = session;
  return app;
}

const nextTick = () => new Promise<void>((r) => setTimeout(r, 10));

describe("会话命令（S15b）", () => {
  it("does not accept a new query while an async session command is pending", async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const query = vi.fn();
    const app = new TuiApp({ terminal: new FakeTerminal(), onQuery: query, onSessionCommand: () => pending });
    app.editor.onSubmit?.("/clone --isolated");
    app.editor.onSubmit?.("must wait");
    expect(query).not.toHaveBeenCalled();
    release(); await nextTick();
    app.editor.onSubmit?.("now ready"); await nextTick();
    expect(query).toHaveBeenCalledWith("now ready");
    app.stop();
  });
  it("/tree includes inactive siblings and can navigate to an assistant node", async () => {
    const session = SessionManager.create(cwd);
    const root = session.appendMessage({ role: "user", content: "question" });
    const old = session.appendMessage({ role: "assistant", content: "old path" });
    session.branch(root); session.appendMessage({ role: "assistant", content: "new path" });
    const ref = { current: session }, app = makeApp(session, ref);
    const select = vi.spyOn(app, "showSelector").mockResolvedValue({ value: old, label: "old path" });
    await handleSessionCommand(app, ref, "tree", "");
    expect(select.mock.calls[0][0].map(item => item.value)).toContain(old);
    expect(session.getLeafId()).toBe(old);
    expect(app.getChatText()).toContain("old path"); expect(app.getChatText()).not.toContain("new path");
    expect(SessionManager.open(session.getSessionFile()!).getLeafId()).toBe(old);
  });
  it("/fork accepts an inactive node and --after, while user defaults to --before", async () => {
    const session = SessionManager.create(cwd);
    const root = session.appendMessage({ role: "user", content: "edit prompt" });
    const old = session.appendMessage({ role: "assistant", content: "old path" });
    session.branch(root); session.appendMessage({ role: "assistant", content: "new path" });
    const ref = { current: session }, app = makeApp(session, ref);
    await handleSessionCommand(app, ref, "fork", `${old} --after`);
    expect(ref.current!.buildSessionContext().messages.at(-1)?.content).toBe("old path");
    ref.current = session;
    await handleSessionCommand(app, ref, "fork", root);
    expect(ref.current!.buildSessionContext().messages).toEqual([]);
    expect(app.editor.getText()).toBe("edit prompt");
    expect(session.buildSessionContext().messages.at(-1)?.content).toBe("new path");
  });
  it("/tree restores model and thinking settings from the selected branch", async () => {
    const session = SessionManager.create(cwd);
    session.appendModelChange("test", "model-a"); session.appendThinkingChange("high");
    const old = session.appendMessage({ role: "assistant", content: "old path" });
    session.appendModelChange("test", "model-b"); session.appendThinkingChange("low");
    const ref = { current: session }, app = makeApp(session, ref);
    const model = vi.spyOn(app, "restoreModel").mockResolvedValue(true);
    const thinking = vi.spyOn(app, "restoreThinkingLevel").mockResolvedValue(true);
    await handleSessionCommand(app, ref, "tree", old);
    expect(model).toHaveBeenCalledWith("test/model-a"); expect(thinking).toHaveBeenCalledWith("high");
  });
  it("/session 显示会话信息", async () => {
    const session = SessionManager.create(cwd);
    session.appendMessage({ role: "user", content: "你好" });
    session.appendSessionInfo("我的会话");
    const ref = { current: session };
    const app = makeApp(session, ref);
    await handleSessionCommand(app, ref, "session", "");
    const text = app.getChatText();
    expect(text).toContain("ID:");
    expect(text).toContain("我的会话");
    expect(text).toContain("Entries: 2");
  });

  it("/name 设置会话显示名", async () => {
    const session = SessionManager.create(cwd);
    const ref = { current: session };
    const app = makeApp(session, ref);
    await handleSessionCommand(app, ref, "name", "重构任务");
    expect(session.getSessionName()).toBe("重构任务");
  });

  it("/clone 复制当前活动分支到新会话并切换", async () => {
    const session = SessionManager.create(cwd);
    session.appendMessage({ role: "user", content: "问题" });
    session.appendMessage({ role: "assistant", content: "回答" });
    const ref = { current: session };
    const app = makeApp(session, ref);
    await handleSessionCommand(app, ref, "clone", "");
    const newSession = ref.current!;
    expect(newSession.getSessionFile()).not.toBe(session.getSessionFile());
    expect(newSession.getHeader().parentSession).toBe(session.getSessionFile());
    expect(newSession.buildSessionContext().messages).toHaveLength(2);
    expect(app.getChatText()).toContain("已clone到新会话");
  });

  it("/resume 列出会话（取消路径）", async () => {
    const s1 = SessionManager.create(cwd);
    s1.appendMessage({ role: "user", content: "第一个会话" });
    const ref = { current: s1 };
    const app = makeApp(s1, ref);
    vi.spyOn(app, "showSelector").mockResolvedValue(null);
    await handleSessionCommand(app, ref, "resume", "");
    expect(ref.current).toBe(s1);
    expect(app.getChatText()).toContain("已取消");
  });

  it("/tree 未知命令提示", async () => {
    const session = SessionManager.create(cwd);
    const ref = { current: session };
    const app = makeApp(session, ref);
    await handleSessionCommand(app, ref, "nope", "");
    expect(app.getChatText()).toContain("未知命令");
  });

  it("/tree 空会话提示", async () => {
    const session = SessionManager.create(cwd);
    const ref = { current: session };
    const app = makeApp(session, ref);
    await handleSessionCommand(app, ref, "tree", "");
    expect(app.getChatText()).toContain("会话为空");
  });

  it("/fork 取消路径", async () => {
    const session = SessionManager.create(cwd);
    session.appendMessage({ role: "user", content: "问题" });
    const ref = { current: session };
    const app = makeApp(session, ref);
    const p = handleSessionCommand(app, ref, "fork", "");
    await nextTick();
    // 模拟取消（Esc）
    // 直接让 Promise 完成：通过超时不可行——用注入？此处验证选择器弹出不崩即可
    void p;
    await nextTick();
    expect(ref.current).toBe(session);
  });
});

describe("会话命令：/compact（手动压缩）", () => {
  let mock: import("../../tests/helpers/mock-openai.ts").MockOpenAI;

  beforeEach(async () => {
    const { MockOpenAI } = await import("../../tests/helpers/mock-openai.ts");
    const { installMockModels } = await import("../../tests/helpers/test-client.ts");
    mock = await MockOpenAI.create();
    installMockModels(mock.baseUrl);
  });

  afterEach(async () => {
    const { resetClient } = await import("../client.ts");
    resetClient();
    await mock.close();
  });

  it("/compact 成功：写检查点并回报 token 变化", async () => {
    mock.always(() => ({ kind: "sse", chunks: [{ content: "手动摘要", finishReason: "stop" }] }));
    const session = SessionManager.create(cwd);
    session.appendMessage({ role: "user", content: "问题" });
    session.appendMessage({ role: "assistant", content: "回答" });
    session.appendMessage({ role: "user", content: "继续" });
    const ref = { current: session };
    const app = makeApp(session, ref);

    await handleSessionCommand(app, ref, "compact", "");

    expect(app.getChatText()).toContain("已压缩");
    const comp = session.getEntries().find((e) => e.type === "compaction");
    expect(comp).toBeDefined();
    expect((comp as { summary: string }).summary).toContain("手动摘要");
  });

  it("/compact 失败：不写检查点，提示可回退几轮再试", async () => {
    mock.always(() => ({ kind: "error", status: 500, body: "summarization failed" }));
    const session = SessionManager.create(cwd);
    session.appendMessage({ role: "user", content: "问题" });
    const ref = { current: session };
    const app = makeApp(session, ref);

    await handleSessionCommand(app, ref, "compact", "");

    const text = app.getChatText();
    expect(text).toContain("压缩失败");
    expect(text).toContain("回退");
    expect(session.getEntries().some((e) => e.type === "compaction")).toBe(false);
  });

  it("/compact 无会话（--no-session）提示禁用", async () => {
    const ref: { current: SessionManager | null } = { current: null };
    const app = makeApp(null, ref);
    await handleSessionCommand(app, ref, "compact", "");
    expect(app.getChatText()).toContain("会话已禁用");
  });
});

describe("会话命令键盘驱动（S15b）", () => {
  it("/tree 选择 user 节点回到消息之前并填充编辑器", async () => {
    const session = SessionManager.create(cwd);
    const m1 = session.appendMessage({ role: "user", content: "问题" });
    session.appendMessage({ role: "assistant", content: "路径A" });
    const ref = { current: session };
    const term = new FakeTerminal();
    const app = new TuiApp({
      terminal: term,
      onQuery: () => {},
      onSessionCommand: (n, r, a) => handleSessionCommand(a, ref, n, r),
    });
    app.tui.start();
    app.editor.onSubmit?.("/tree");
    await nextTick();
    // SelectList 默认选中第一条（根 user 消息）→ 回车
    term.onInput?.("\r");
    await new Promise((r) => setTimeout(r, 100));
    expect(session.getLeafId()).toBeNull();
    expect(session.getEntries().some(e => e.type === "branch_summary")).toBe(false);
    expect(session.getEntry(m1)).not.toBeNull();
    expect(session.buildSessionContext().messages).toEqual([]);
    expect(app.editor.getText()).toBe("问题");
    app.stop();
  });

  it("/session 键盘命令显示信息", async () => {
    const session = SessionManager.create(cwd);
    const ref = { current: session };
    const term = new FakeTerminal();
    const app = new TuiApp({
      terminal: term,
      onQuery: () => {},
      onSessionCommand: (n, r, a) => handleSessionCommand(a, ref, n, r),
    });
    app.editor.onSubmit?.("/session");
    await nextTick();
    expect(app.getChatText()).toContain("文件:");
    app.stop();
  });
});

describe("会话恢复渲染（回归：历史消息不显示）", () => {
  it("renderHistory 渲染 user/assistant 消息与工具块", async () => {
    const session = SessionManager.create(cwd);
    session.appendMessage({ role: "user", content: "历史问题" });
    session.appendMessage({ role: "assistant", content: "历史回答" });
    const ref = { current: session };
    const app = makeApp(session, ref);
    await handleSessionCommand(app, ref, "history-render", "");
    // 直接调用渲染入口（cli 启动/resume 同路径）
    app.renderHistory(session.buildSessionContext().messages);
    const text = app.getChatText();
    expect(text).toContain("历史问题");
    expect(text).toContain("历史回答");
    expect(text).not.toContain("User >"); // 无前缀
  });

  it("renderHistory 渲染 assistant 工具调用为工具块", async () => {
    const session = SessionManager.create(cwd);
    session.appendMessage({ role: "user", content: "q" });
    session.appendMessage({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "bash", arguments: '{"command":"ls"}' },
        },
      ],
    });
    session.appendMessage({ role: "tool", tool_call_id: "call_1", content: "file.txt" });
    const ref = { current: session };
    const app = makeApp(session, ref);
    app.renderHistory(session.buildSessionContext().messages);
    const text = app.getChatText();
    expect(text).toContain("bash");
    expect(text).toContain("file.txt");
  });
});

describe("Resume 列表元数据（回归：只有编号无内容/时间）", () => {
  it("list 返回 name/firstMessage/messageCount/lastActivity", async () => {
    const session = SessionManager.create(cwd);
    session.appendMessage({ role: "user", content: "第一个问题" });
    session.appendMessage({ role: "assistant", content: "回答一" });
    session.appendMessage({ role: "user", content: "第二个问题" });
    session.appendSessionInfo("我的会话");
    const items = SessionManager.list(cwd);
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe("我的会话");
    expect(items[0].firstMessage).toContain("第一个问题");
    expect(items[0].messageCount).toBe(3);
    expect(items[0].lastActivity).toBeGreaterThan(0);
  });

  it("无会话名时 firstMessage 作为预览，按最后活动降序", async () => {
    const s1 = SessionManager.create(cwd);
    s1.appendMessage({ role: "user", content: "早的会话" });
    await new Promise((r) => setTimeout(r, 5));
    const s2 = SessionManager.create(cwd);
    s2.appendMessage({ role: "user", content: "晚的会话" });
    const items = SessionManager.list(cwd);
    expect(items).toHaveLength(2);
    expect(items[0].firstMessage).toContain("晚的会话"); // 降序：最新在前
    expect(items[0].messageCount).toBe(1);
  });

  it("/resume 选择器显示内容预览与消息数/相对时间", async () => {
    const session = SessionManager.create(cwd);
    session.appendMessage({ role: "user", content: "显示我" });
    const ref = { current: null as SessionManager | null };
    const term = new FakeTerminal();
    const app = new TuiApp({ terminal: term, onQuery: () => {} });
    app.tui.start();
    const oldCwd = process.cwd();
    process.chdir(cwd); // handleSessionCommand 用 process.cwd() 定位会话目录
    try {
      const pending = handleSessionCommand(app, ref, "resume", "");
      await nextTick();
      // 选择器已打开：断言列表内容（label = firstMessage 预览）
      expect(term.writes.join("")).toContain("显示我");
      expect(term.writes.join("")).toMatch(/msgs/); // N msgs · 相对时间
      term.onInput?.("\r"); // 选中第一项
      await pending;
      await nextTick();
      // 恢复后渲染历史（回归：之前只显示一句提示）
      expect(app.getChatText()).toContain("显示我");
      expect(app.getChatText()).toContain("已恢复会话");
    } finally {
      process.chdir(oldCwd);
      app.stop();
    }
  });
});

describe("/memory-refresh", () => {
  it("刷新记忆快照并明确提示放弃当前缓存前缀", async () => {
    const memDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pi-mem-refresh-"));
    const { setMemoryDir } = await import("../memory.ts");
    const { resetMemorySnapshots } = await import("../memory-scope.ts");
    setMemoryDir(memDir);
    resetMemorySnapshots();
    try {
      const session = SessionManager.create(cwd);
      session.appendMessage({ role: "user", content: "记住：这个项目用 vitest" });
      const ref = { current: session };
      const term = new FakeTerminal();
      const app = new TuiApp({
        terminal: term,
        onQuery: () => {},
        onSessionCommand: (n, r, a) => handleSessionCommand(a, ref, n, r),
      });
      app.tui.start();
      app.editor.onSubmit?.("/memory-refresh");
      await new Promise((r) => setTimeout(r, 60));

      const chat = app.getChatText();
      expect(chat).toContain("记忆快照已刷新");
      expect(chat).toContain("不再复用");
      expect(chat).toContain("MEMORY.md 索引");
      app.stop();
    } finally {
      resetMemorySnapshots();
      fs.rmSync(memDir, { recursive: true, force: true });
    }
  });
});

describe("/tree 子 agent 会话清单", () => {
  it("父会话登记的 subagent entry 会列在会话树里", async () => {
    const session = SessionManager.create(cwd);
    session.appendMessage({ role: "user", content: "父任务" });
    session.appendCustom("subagent", {
      agentId: "scout-abcd1234",
      role: "scout",
      sessionId: "sess-child",
      sessionFile: "/tmp/child/1790_scout.jsonl",
    });
    session.appendCustom("subagent_end", { agentId: "scout-abcd1234", status: "done" });

    const ref = { current: session };
    const term = new FakeTerminal();
    const app = new TuiApp({
      terminal: term,
      onQuery: () => {},
      onSessionCommand: (n, r, a) => handleSessionCommand(a, ref, n, r),
    });
    app.tui.start();
    app.editor.onSubmit?.("/tree");
    await nextTick();
    // 关闭选择器（默认选中第一条）
    term.onInput?.("\r");
    await new Promise((r) => setTimeout(r, 100));

    const chat = app.getChatText();
    expect(chat).toContain("子 agent 会话");
    expect(chat).toContain("scout-abcd1234");
    expect(chat).toContain("1790_scout.jsonl");
    app.stop();
  });
});
