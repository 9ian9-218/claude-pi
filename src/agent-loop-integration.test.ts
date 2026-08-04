import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
