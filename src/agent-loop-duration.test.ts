/**
 * agent-loop-duration.test.ts — 运行时耗时补记（S4）
 *
 * agent-loop 为每条落盘消息补记真实耗时：
 * - assistant 消息：模型请求 durationMs（发出→响应完成）
 * - tool 消息：工具执行 durationMs + 失败标记 toolError
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockOpenAI } from "../tests/helpers/mock-openai.ts";
import { installMockModels } from "../tests/helpers/test-client.ts";
import { resetClient, type ChatMessage } from "./client.ts";
import { agentLoop } from "./agent-loop.ts";
import { LoopOptions } from "./loop-options.ts";
import { installBuiltinHooks } from "./hook.ts";
import { runWithWorkdir } from "./workdir.ts";
import { SessionManager } from "./session-manager.ts";

let mock: MockOpenAI;
let ws: string;
const ORIG_SESSION_ROOT = process.env.CLAUDE_PI_SESSION_ROOT;

beforeEach(async () => {
  resetClient();
  mock = await MockOpenAI.create();
  installMockModels(mock.baseUrl);
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pi-dur-"));
  // 会话根隔离：SessionManager.create 落临时根，不污染项目 .agent/sessions
  process.env.CLAUDE_PI_SESSION_ROOT = ws;
  installBuiltinHooks();
});

afterEach(async () => {
  resetClient();
  if (ORIG_SESSION_ROOT === undefined) delete process.env.CLAUDE_PI_SESSION_ROOT;
  else process.env.CLAUDE_PI_SESSION_ROOT = ORIG_SESSION_ROOT;
  await mock.close();
  fs.rmSync(ws, { recursive: true, force: true });
});

const quiet = new LoopOptions({ quietOutput: true });

describe("agentLoop 耗时补记", () => {
  it("assistant 消息带模型请求 durationMs，tool 消息带执行 durationMs", async () => {
    mock.push(() => ({
      kind: "sse",
      chunks: [
        {
          toolCalls: [
            { index: 0, id: "call_1", name: "read_file", arguments: '{"path":"a.txt"}' },
          ],
          finishReason: "tool_calls",
        },
      ],
    }));
    mock.push(() => ({
      kind: "sse",
      chunks: [{ content: "done", finishReason: "stop" }],
    }));

    await runWithWorkdir(ws, async () => {
      const messages: ChatMessage[] = [{ role: "user", content: "读 a.txt" }];
      await agentLoop(messages, { loopOptions: quiet });
      const assistant = messages.find((m) => m.role === "assistant") as ChatMessage & {
        durationMs?: number;
      };
      const tool = messages.find((m) => m.role === "tool") as ChatMessage & {
        durationMs?: number;
      };
      expect(typeof assistant.durationMs).toBe("number");
      expect(typeof tool.durationMs).toBe("number");
    });
  });

  it("非法参数的工具调用标记 toolError=true 且记录耗时", async () => {
    mock.push(() => ({
      kind: "sse",
      chunks: [
        {
          toolCalls: [
            { index: 0, id: "call_bad", name: "read_file", arguments: "not json" },
          ],
          finishReason: "tool_calls",
        },
      ],
    }));
    mock.push(() => ({
      kind: "sse",
      chunks: [{ content: "ok", finishReason: "stop" }],
    }));

    await runWithWorkdir(ws, async () => {
      const messages: ChatMessage[] = [{ role: "user", content: "go" }];
      await agentLoop(messages, { loopOptions: quiet });
      const tool = messages.find((m) => m.role === "tool") as ChatMessage & {
        toolError?: boolean;
        durationMs?: number;
      };
      expect(tool.toolError).toBe(true);
      expect(typeof tool.durationMs).toBe("number");
    });
  });

  it("会话模式：durationMs 随消息落盘并可回读", async () => {
    mock.push(() => ({
      kind: "sse",
      chunks: [{ content: "你好", finishReason: "stop" }],
    }));

    await runWithWorkdir(ws, async () => {
      const session = SessionManager.create(path.join(ws, "proj"));
      const messages: ChatMessage[] = [{ role: "user", content: "hi" }];
      await agentLoop(messages, { session, loopOptions: quiet });
      const branch = session.getBranch();
      const assistant = branch.find(
        (e) => e.type === "message" && (e as { message: ChatMessage }).message.role === "assistant",
      ) as { message: ChatMessage & { durationMs?: number } };
      expect(typeof assistant.message.durationMs).toBe("number");
      // 重新打开文件（模拟断连恢复）后字段仍在
      const reopened = SessionManager.open(session.getSessionFile()!);
      const again = reopened
        .getBranch()
        .find(
          (e) => e.type === "message" && (e as { message: ChatMessage }).message.role === "assistant",
        ) as { message: ChatMessage & { durationMs?: number } };
      expect(typeof again.message.durationMs).toBe("number");
    });
  });
});