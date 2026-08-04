import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockOpenAI } from "../tests/helpers/mock-openai.ts";
import { resetClient, type ChatMessage } from "./client.ts";
import { agentLoop } from "./agent-loop.ts";
import { LoopOptions } from "./loop-options.ts";
import { installBuiltinHooks } from "./hook.ts";
import { runWithWorkdir } from "./workdir.ts";

const originalEnv = { ...process.env };
let mock: MockOpenAI;
let ws: string;

beforeEach(async () => {
  process.env = { ...originalEnv };
  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_MODEL = "gpt-test";
  resetClient();
  mock = await MockOpenAI.create();
  process.env.OPENAI_BASE_URL = mock.baseUrl;
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pi-int-"));
  installBuiltinHooks();
});

afterEach(async () => {
  process.env = { ...originalEnv };
  await mock.close();
  fs.rmSync(ws, { recursive: true, force: true });
});

const quiet = new LoopOptions({ quietOutput: true });

describe("agentLoop 集成（03/04）", () => {
  it("429 后指数退避重试成功（错误恢复接入 loop）", async () => {
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

      // 预算达标后停止：最大的 1 条落盘（Python 行为）
      const dir = path.join(ws, ".task_outputs", "tool-results");
      expect(fs.readdirSync(dir).length).toBe(1);
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
  it("记忆注入：请求体 user 消息含 <relevant_memories>", async () => {
    // select 调用（非流式 json）→ 主调用（sse）
    mock.push(() => ({ kind: "json", content: "[0]" }));
    mock.push(() => ({ kind: "sse", chunks: [{ content: "ok", finishReason: "stop" }] }));
    // Stop hook 的异步提取静默失败即可（无队列响应）
    const memDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pi-memint-"));
    const { setMemoryDir, writeMemoryFile } = await import("./memory.ts");
    setMemoryDir(memDir);
    try {
      writeMemoryFile("arch-note", "project", "architecture note", "the memory body");
      const messages: ChatMessage[] = [{ role: "user", content: "about architecture" }];
      await agentLoop(messages, { loopOptions: quiet });
      const mainReq = mock.requests.find((r) => r.messages.some((m) => m.role === "system"));
      const userMsg = mainReq?.messages.find((m) => m.role === "user");
      expect(String(userMsg?.content)).toContain("<relevant_memories>");
      expect(String(userMsg?.content)).toContain("the memory body");
    } finally {
      fs.rmSync(memDir, { recursive: true, force: true });
    }
  });
});

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

  it("L4：超 CONTEXT_LIMIT 写 compaction entry（retainedTail），上下文从检查点重建", async () => {
    const { SessionManager, setSessionRoot } = await import("./session-manager.ts");
    const { CONTEXT_LIMIT } = await import("./compact.ts");
    const sessDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pi-l4-"));
    setSessionRoot(sessDir);
    try {
      // 摘要调用（非流式 json）→ 主调用（sse）
      mock.push(() => ({ kind: "json", content: "早期对话摘要" }));
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
      expect(contents.some((c) => c.includes("[Compacted]"))).toBe(true);
      expect(contents.some((c) => c === huge)).toBe(false);
      expect(contents).toContain("最新问题");
      void CONTEXT_LIMIT;
    } finally {
      fs.rmSync(sessDir, { recursive: true, force: true });
    }
  }, 30000);
});
