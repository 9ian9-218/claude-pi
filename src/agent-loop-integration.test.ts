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
