import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockOpenAI } from "../tests/helpers/mock-openai.ts";
import { installMockModels } from "../tests/helpers/test-client.ts";
import { setRetryPolicyForTest } from "./error-recovery.ts";
import { setSettingsOverrideForTest } from "./settings.ts";
import { resetClient, type ChatMessage } from "./client.ts";
import { agentLoop } from "./agent-loop.ts";
import { LoopOptions } from "./loop-options.ts";
import { installBuiltinHooks, registerHook } from "./hook.ts";
import { SessionManager } from "./session-manager.ts";
import { runWithWorkdir } from "./workdir.ts";

let mock: MockOpenAI;
let ws: string;

beforeEach(async () => {
  resetClient();
  setSettingsOverrideForTest({ retry: { enabled: true, maxRetries: 3, baseDelayMs: 2000 }, compaction: { enabled: true } });
  mock = await MockOpenAI.create();
  installMockModels(mock.baseUrl);
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pi-int-"));
  installBuiltinHooks();
});

afterEach(async () => {
  resetClient();
  // kE 触发测试预置的当前模型不泄漏到其他用例（resolveCurrentModel 缓存）
  const { resetAiRuntime } = await import("./ai-runtime.ts");
  resetAiRuntime();
  setSettingsOverrideForTest(null);
  await mock.close();
  fs.rmSync(ws, { recursive: true, force: true });
});

const quiet = new LoopOptions({ quietOutput: true, skipMemoryStopHook: true });

describe("agentLoop 集成（03/04）", () => {
  it("429 后指数退避重试成功（错误恢复接入 loop）", async () => {
    setRetryPolicyForTest({ enabled: true, maxRetries: 1, baseDelayMs: 1 });
    mock.push(() => ({ kind: "error", status: 429, body: "rate limited" }));
    mock.push(() => ({ kind: "sse", chunks: [{ content: "recovered", finishReason: "stop" }] }));
    const messages: ChatMessage[] = [{ role: "user", content: "go" }];
    await agentLoop(messages, { loopOptions: quiet });
    expect(messages[messages.length - 1].content).toBe("recovered");
    expect(mock.requests).toHaveLength(2);
  });

  it("L3 budget：超大工具结果落盘，下一轮请求体含占位预览", async () => {
    const big = "y".repeat(300_000); // ~84k tokens/条，两条合计超 120k 预算
    mock.push(() => ({
      kind: "sse",
      chunks: [
        {
          toolCalls: [
            { index: 0, id: "call_a", name: "read_file", arguments: '{"path":"a.txt"}' },
            { index: 1, id: "call_b", name: "read_file", arguments: '{"path":"b.txt"}' },
          ],
          finishReason: "tool_calls",
        },
      ],
    }));
    mock.push(() => ({ kind: "sse", chunks: [{ content: "done", finishReason: "stop" }] }));

    await runWithWorkdir(ws, async () => {
      fs.writeFileSync(path.join(ws, "a.txt"), big);
      fs.writeFileSync(path.join(ws, "b.txt"), big);
      const messages: ChatMessage[] = [{ role: "user", content: "read both" }];
      await agentLoop(messages, { loopOptions: quiet });

      // L3（CC 式）：每条超限工具输出在出口处完整落盘（双保险）
      const dir = path.join(ws, ".task_outputs", "tool-results");
      expect(fs.readdirSync(dir).length).toBe(2);
      // 第二轮请求体中该大 tool 结果被替换为占位
      const second = mock.requests[1];
      const toolContents = second.messages
        .filter((m) => m.role === "tool")
        .map((m) => String(m.content));
      expect(toolContents.some((c) => c.includes("<persisted-output>"))).toBe(true);
    });
  });
});

describe("agentLoop 集成（05 记忆）", () => {
  it("记忆注入：进入 system 段且会话内冻结，user 消息保持原样", async () => {
    // select 调用（非流式 json）→ 主调用（sse）
    mock.push(() => ({ kind: "sse", chunks: [{ content: "[0]", finishReason: "stop" }] }));
    mock.push(() => ({ kind: "sse", chunks: [{ content: "ok", finishReason: "stop" }] }));
    const memDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pi-memint-"));
    const { setMemoryDir, writeMemoryFile } = await import("./memory.ts");
    const { resetMemorySnapshots } = await import("./memory-scope.ts");
    setMemoryDir(memDir);
    resetMemorySnapshots();
    try {
      writeMemoryFile("arch-note", "project", "architecture note", "the memory body");
      const messages: ChatMessage[] = [{ role: "user", content: "about architecture" }];
      await agentLoop(messages, { loopOptions: quiet });

      const mainReq = mock.requests.find((r) => r.messages.some((m) => m.role === "system"));
      const systemMsg = mainReq?.messages.find((m) => m.role === "system");
      const userMsg = mainReq?.messages.find((m) => m.role === "user");
      // 记忆进 system 段（前缀稳定），user 消息不再被改写
      expect(String(systemMsg?.content)).toContain("<relevant_memories>");
      expect(String(systemMsg?.content)).toContain("the memory body");
      expect(String(userMsg?.content)).toBe("about architecture");

      // 冻结：本会话内新增的记忆不影响当前会话的 system 前缀
      const frozen = String(systemMsg?.content);
      writeMemoryFile("new-note", "project", "new note", "NEW MEMORY BODY");
      mock.push(() => ({ kind: "sse", chunks: [{ content: "ok2", finishReason: "stop" }] }));
      await agentLoop(
        [...messages, { role: "assistant", content: "ok" }, { role: "user", content: "continue" }],
        { loopOptions: quiet },
      );
      const later = mock.requests
        .filter((r) => r.messages.some((m) => m.role === "system"))
        .pop();
      const laterSystem = String(later?.messages.find((m) => m.role === "system")?.content ?? "");
      expect(laterSystem).toBe(frozen);
      expect(laterSystem).not.toContain("NEW MEMORY BODY");
    } finally {
      resetMemorySnapshots();
      fs.rmSync(memDir, { recursive: true, force: true });
    }
  });});

describe("agentLoop 集成（06 后台任务）", () => {
  it("后台任务完成通知在下一轮对话注入为 user 消息", async () => {
    mock.push(() => ({
      kind: "sse",
      chunks: [
        {
          toolCalls: [
            {
              index: 0,
              id: "call_bg",
              name: "run_bash",
              arguments: '{"command":"echo bg-task-done","run_in_background":true}',
            },
          ],
          finishReason: "tool_calls",
        },
      ],
    }));
    mock.push(() => ({ kind: "sse", chunks: [{ content: "started", finishReason: "stop" }] }));
    mock.push(() => ({ kind: "sse", chunks: [{ content: "final", finishReason: "stop" }] }));
    const messages: ChatMessage[] = [{ role: "user", content: "run in bg" }];
    await agentLoop(messages, { loopOptions: quiet });
    // 第一轮：占位 tool 结果
    expect(String(messages[3].content)).toContain("[Background task bg_");
    // 等后台完成通知入队后再进入第二轮
    const { hasPendingNotifications } = await import("./message-queue.ts");
    await vi.waitFor(() => expect(hasPendingNotifications()).toBe(true), {
      timeout: 10000,
      interval: 50,
    });
    // 第二轮对话：通知在轮首注入
    messages.push({ role: "user", content: "next" });
    await agentLoop(messages, { loopOptions: quiet });
    const injected = messages.find(
      (m) => m.role === "user" && String(m.content).includes("<task_notification>"),
    );
    expect(injected).toBeDefined();
    expect(String(injected?.content)).toContain("<status>completed</status>");
    expect(String(injected?.content)).toContain("bg-task-done");
  }, 30000);
});

describe("agentLoop 集成（08 任务看板 + worktree）", () => {
  it("create→claim→complete 全流程：任务持久化 + worktree 生命周期", async () => {
    // 临时 git 仓库 + tasks 目录注入
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pi-ig-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "a.txt"), "x");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });
    const { setGitRoot } = await import("./worktree.ts");
    const { setTasksDir } = await import("./tasks.ts");
    const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pi-it-"));
    setGitRoot(repo);
    setTasksDir(taskDir);

    mock.push(() => ({
      kind: "sse",
      chunks: [
        {
          toolCalls: [
            {
              index: 0,
              id: "call_c",
              name: "create_task",
              arguments: '{"subject":"重构模块","description":"desc","blockedBy":[]}',
            },
          ],
          finishReason: "tool_calls",
        },
      ],
    }));
    mock.push(() => ({
      kind: "sse",
      chunks: [
        {
          toolCalls: [
            { index: 0, id: "call_cl", name: "claim_task", arguments: '{"task_id":"task_1"}' },
          ],
          finishReason: "tool_calls",
        },
      ],
    }));
    mock.push(() => ({
      kind: "sse",
      chunks: [
        {
          toolCalls: [
            { index: 0, id: "call_cc", name: "complete_task", arguments: '{"task_id":"task_1"}' },
          ],
          finishReason: "tool_calls",
        },
      ],
    }));
    mock.push(() => ({ kind: "sse", chunks: [{ content: "all done", finishReason: "stop" }] }));

    try {
      const messages: ChatMessage[] = [{ role: "user", content: "create, claim, complete" }];
      await agentLoop(messages, { loopOptions: quiet });

      // 任务状态流转
      const taskRaw = JSON.parse(fs.readFileSync(path.join(taskDir, "task_1.json"), "utf8"));
      expect(taskRaw.status).toBe("completed");
      // worktree 生命周期：claim 创建 → complete 移除
      const wt = path.join(repo, ".agent", "worktrees", "task_1");
      expect(fs.existsSync(wt)).toBe(false);
      // 工具结果可见
      const all = messages.map((m) => String(m.content ?? "")).join(" ");
      expect(all).toContain("Created task_1");
      expect(all).toContain("Claimed task_1");
      expect(all).toContain("Completed task_1");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(taskDir, { recursive: true, force: true });
    }
  }, 30000);
});

describe("agentLoop 集成（10 队友注入）", () => {
  it("队友消息在轮首注入为 user 消息", async () => {
    const { setTeamsDir } = await import("./teammates/constants.ts");
    const { sendPlainMessage } = await import("./teammates/mailbox.ts");
    const { pollOnce, clearPollerQueues } = await import("./teammates/poller.ts");
    const { createTeam } = await import("./teammates/team-helpers.ts");
    const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pi-tm-"));
    setTeamsDir(teamDir);
    clearPollerQueues();
    try {
      createTeam("default", "team-lead");
      await sendPlainMessage({
        fromAgent: "worker-1",
        toAgent: "team-lead",
        text: "任务完成报告",
        teamName: "default",
        color: "green",
      });
      await pollOnce("default");
      mock.always(() => ({ kind: "sse", chunks: [{ content: "收到", finishReason: "stop" }] }));
      const messages: ChatMessage[] = [{ role: "user", content: "继续" }];
      await agentLoop(messages, { loopOptions: quiet });
      // 请求体含注入的队友消息
      const req = mock.requests.find((r) => r.messages.some((m) => m.role === "system"));
      const userContents = req?.messages.filter((m) => m.role === "user").map((m) => String(m.content));
      expect(userContents?.some((c) => c.includes("<teammate-message") && c.includes("任务完成报告"))).toBe(
        true,
      );
    } finally {
      fs.rmSync(teamDir, { recursive: true, force: true });
    }
  });
});

describe("agentLoop 集成（12 会话机制）", () => {
  it("会话模式：消息同步落盘，重开文件上下文一致（崩溃恢复）", async () => {
    const { SessionManager, setSessionRoot } = await import("./session-manager.ts");
    const sessDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pi-sessint-"));
    setSessionRoot(sessDir);
    try {
      mock.always(() => ({ kind: "sse", chunks: [{ content: "回复内容", finishReason: "stop" }] }));
      const session = SessionManager.create(process.cwd());
      session.appendMessage({ role: "user", content: "第一问" });
      await agentLoop(session.buildSessionContext().messages, { loopOptions: quiet, session });
      // 模拟崩溃：丢弃内存对象，直接重开文件
      const file = session.getSessionFile()!;
      const recovered = SessionManager.open(file);
      const ctx = recovered.buildSessionContext();
      const contents = ctx.messages.map((m) => String(m.content));
      expect(contents).toContain("第一问");
      expect(contents).toContain("回复内容");
    } finally {
      fs.rmSync(sessDir, { recursive: true, force: true });
    }
  });

  it("L4：kE 口径触发——预置带 usage 的 assistant（真实 usage 超阈值）写 compaction", async () => {
    const { SessionManager, setSessionRoot } = await import("./session-manager.ts");
    const { makeCompletionsModel } = await import("../tests/helpers/test-client.ts");
    const { setCurrentModel } = await import("./ai-runtime.ts");
    const { getCompactionThreshold } = await import("./compact.ts");
    const sessDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pi-l4ke-"));
    setSessionRoot(sessDir);
    try {
      setCurrentModel(makeCompletionsModel("gpt-test", mock.baseUrl));
      // 阈值口径回归：窗口/预留都取自模型元数据（128K 窗口、maxTokens 8K）
      // → 0.92×(128K−8K)=110,400；这条断言钉住"不再写死 token 数"
      expect(getCompactionThreshold()).toBe(Math.round((128_000 - 8_000) * 0.92));
      mock.push(() => ({ kind: "sse", chunks: [{ content: "kE 摘要", finishReason: "stop" }] }));
      mock.push(() => ({ kind: "sse", chunks: [{ content: "ok", finishReason: "stop" }] }));
      const session = SessionManager.create(process.cwd());
      // 真实 usage 刚过阈值（字符量很小，只有 kE 口径能触发）
      const threshold = getCompactionThreshold();
      const usage = {
        input: threshold + 1, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: threshold + 101,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
      session.appendMessage({ role: "user", content: "问题" });
      session.appendMessage({ role: "assistant", content: "之前的大响应", usage });
      session.appendMessage({ role: "user", content: "继续" });
      await agentLoop(session.buildSessionContext().messages, { loopOptions: quiet, session });
      const comp = session.getEntries().find((e) => e.type === "compaction");
      expect(comp).toBeDefined();
      expect((comp as { summary: string }).summary).toContain("kE 摘要");
      expect((comp as { tokensBefore: number }).tokensBefore).toBeGreaterThan(threshold + 1);
    } finally {
      fs.rmSync(sessDir, { recursive: true, force: true });
    }
  }, 30000);

  it("L4：摘要失败（api_error）→ 不写 entry、回合继续（CC 错误分类语义）", async () => {
    const { SessionManager, setSessionRoot } = await import("./session-manager.ts");
    const { makeCompletionsModel } = await import("../tests/helpers/test-client.ts");
    const { setCurrentModel } = await import("./ai-runtime.ts");
    const sessDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pi-l4err-"));
    setSessionRoot(sessDir);
    try {
      setCurrentModel(makeCompletionsModel("gpt-test", mock.baseUrl));
      // 摘要调用 → 500 错误；随后主调用正常（不阻断回合）
      mock.push(() => ({ kind: "error", status: 500, body: "summarization failed" }));
      mock.push(() => ({ kind: "sse", chunks: [{ content: "继续干活", finishReason: "stop" }] }));
      const session = SessionManager.create(process.cwd());
      const usage = {
        input: 500_000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 500_100,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
      session.appendMessage({ role: "user", content: "问题" });
      session.appendMessage({ role: "assistant", content: "大响应", usage });
      session.appendMessage({ role: "user", content: "继续" });
      await agentLoop(session.buildSessionContext().messages, { loopOptions: quiet, session });
      // 无 compaction entry 写入；回合照常产出响应
      expect(session.getEntries().some((e) => e.type === "compaction")).toBe(false);
      expect(mock.requests[mock.requests.length - 1].messages.map((x: { content?: unknown }) => String(x.content))).toContain("继续");
      void setCurrentModel;
    } finally {
      fs.rmSync(sessDir, { recursive: true, force: true });
    }
  }, 30000);

  it("L4：超触发阈值写 compaction entry（字符估算兜底口径）（retainedTail），上下文从检查点重建", async () => {
    const { SessionManager, setSessionRoot } = await import("./session-manager.ts");
    const { getCompactionThreshold } = await import("./compact.ts");
    const sessDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pi-l4-"));
    setSessionRoot(sessDir);
    try {
      // 摘要调用（非流式 json）→ 主调用（sse）
      mock.push(() => ({ kind: "sse", chunks: [{ content: "早期对话摘要", finishReason: "stop" }] }));
      mock.push(() => ({ kind: "sse", chunks: [{ content: "ok", finishReason: "stop" }] }));
      const session = SessionManager.create(process.cwd());
      // 构造超限上下文（~480K tokens 需要约 170 万英文字符）
      const huge = "x".repeat(2_000_000);
      session.appendMessage({ role: "user", content: huge });
      session.appendMessage({ role: "user", content: "最新问题" });
      await agentLoop(session.buildSessionContext().messages, { loopOptions: quiet, session });
      // compaction entry 已写
      const entries = session.getEntries();
      const comp = entries.find((e) => e.type === "compaction");
      expect(comp).toBeDefined();
      expect((comp as { summary: string }).summary).toContain("早期对话摘要");
      // 上下文从检查点重建：不含巨大历史，含 retainedTail
      const ctx = session.buildSessionContext();
      const contents = ctx.messages.map((m) => String(m.content));
      expect(contents.some((c) => c.includes("compacted into the following summary"))).toBe(true);
      expect(contents.some((c) => c === huge)).toBe(false);
      expect(contents).toContain("最新问题");
      // 无模型（kE 不适用）时走 256K 兜底窗口：阈值 = 0.92×(256K − 16% 预留)
      const fallbackReserve = Math.round(256_000 * 0.16);
      expect(getCompactionThreshold()).toBe(Math.round((256_000 - fallbackReserve) * 0.92));
    } finally {
      fs.rmSync(sessDir, { recursive: true, force: true });
    }
  }, 30000);
});

describe("agentLoop 会话落盘与中断审计（恢复）", () => {
  it("工具执行中途中断：保留调用记录并闭合所有未执行工具", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pi-rollback-"));
    try {
      const session = SessionManager.create(process.cwd(), dir);
      session.appendMessage({ role: "user", content: "go" });
      const controller = new AbortController();
      // PreToolUse 时触发中断：第一个工具执行后、第二个工具前 signal 生效
      const unsubscribe = registerHook("PreToolUse", () => {
        controller.abort();
        return null;
      });
      mock.push(() => ({
        kind: "sse",
        chunks: [
          {
            toolCalls: [
              { index: 0, id: "call_1", name: "read_file", arguments: '{"path":"a.txt"}' },
              { index: 1, id: "call_2", name: "read_file", arguments: '{"path":"b.txt"}' },
            ],
            finishReason: "tool_calls",
          },
        ],
      }));
      await runWithWorkdir(ws, async () => {
        fs.writeFileSync(path.join(ws, "a.txt"), "x");
        await agentLoop(session.buildSessionContext().messages, {
          session,
          loopOptions: new LoopOptions({ quietOutput: true, signal: controller.signal }),
        });
      });
      unsubscribe();
      // Cancellation preserves the assistant call and explicit cancelled results.
      const entries = session.getEntries();
      expect(entries.filter((e) => e.type === "message")).toHaveLength(4);
      expect(session.buildSessionContext().messages.filter(m => m.role === "tool").map(m => m.toolStatus)).toEqual(["cancelled", "cancelled"]);
      // Reopening does not erase evidence or leave unmatched tool calls.
      const reopened = SessionManager.open(session.getSessionFile()!);
      expect(reopened.buildSessionContext().messages).toHaveLength(4);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("不可恢复错误：把 [Error] 收尾消息落盘（恢复后可见失败原因）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pi-err-"));
    try {
      const session = SessionManager.create(process.cwd(), dir);
      session.appendMessage({ role: "user", content: "go" });
      setRetryPolicyForTest({ enabled: true, maxRetries: 0, baseDelayMs: 1 });
      mock.push(() => ({ kind: "error", status: 500, body: "boom" }));
      await agentLoop(session.buildSessionContext().messages, { session, loopOptions: quiet });
      const ctx = session.buildSessionContext();
      const last = ctx.messages[ctx.messages.length - 1];
      expect(last.role).toBe("assistant");
      expect(String(last.content)).toContain("[Error]");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// 路由键：provider（opencode zen 网关）要求每个请求带稳定会话标识才肯路由/复用缓存前缀。
// 会话模式取 sessionId；无会话模式（--no-session / 脚本接口）必须退化为稳定的进程级临时 id，
// 否则线上会直接 400 MissingSessionID（见真实环境回归）。
describe("缓存路由键（无会话模式）", () => {
  it("无 session 时仍透传非空 sessionId（否则 provider 400）", async () => {
    const models = installMockModels(mock.baseUrl);
    const spy = vi.spyOn(models, "stream");
    mock.always(() => ({ kind: "sse", chunks: [{ content: "ok", finishReason: "stop" }] }));
    try {
      await agentLoop([{ role: "user", content: "hi" }], { loopOptions: quiet });
      const opts = spy.mock.calls[0]?.[2] as { sessionId?: string } | undefined;
      expect(typeof opts?.sessionId).toBe("string");
      expect((opts?.sessionId ?? "").length).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("同一进程内多次调用复用同一路由键（前缀缓存可命中）", async () => {
    const models = installMockModels(mock.baseUrl);
    const spy = vi.spyOn(models, "stream");
    mock.always(() => ({ kind: "sse", chunks: [{ content: "ok", finishReason: "stop" }] }));
    try {
      await agentLoop([{ role: "user", content: "a" }], { loopOptions: quiet });
      await agentLoop([{ role: "user", content: "b" }], { loopOptions: quiet });
      const first = (spy.mock.calls[0]?.[2] as { sessionId?: string }).sessionId;
      const second = (spy.mock.calls[1]?.[2] as { sessionId?: string }).sessionId;
      expect(first).toBeTruthy();
      expect(first).toBe(second);
    } finally {
      spy.mockRestore();
    }
  });

  it("有 session 时路由键严格等于会话 id", async () => {
    const models = installMockModels(mock.baseUrl);
    const spy = vi.spyOn(models, "stream");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pi-route-"));
    mock.always(() => ({ kind: "sse", chunks: [{ content: "ok", finishReason: "stop" }] }));
    try {
      const session = SessionManager.create(process.cwd(), dir);
      session.appendMessage({ role: "user", content: "go" });
      await agentLoop(session.buildSessionContext().messages, { session, loopOptions: quiet });
      const opts = spy.mock.calls[0]?.[2] as { sessionId?: string } | undefined;
      expect(opts?.sessionId).toBe(session.sessionId);
    } finally {
      spy.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
