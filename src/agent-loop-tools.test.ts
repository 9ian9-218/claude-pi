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
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pi-loop-"));
  installBuiltinHooks();
});

afterEach(async () => {
  process.env = { ...originalEnv };
  await mock.close();
  fs.rmSync(ws, { recursive: true, force: true });
});

const quiet = new LoopOptions({ quietOutput: true });

describe("agentLoop 工具链（S4）", () => {
  it("read→write 工具链端到端：文件真实生效，工具结果进 messages", async () => {
    mock.push(() => ({
      kind: "sse",
      chunks: [
        {
          toolCalls: [{ index: 0, id: "call_1", name: "read_file", arguments: '{"path":"a.txt"}' }],
          finishReason: "tool_calls",
        },
      ],
    }));
    mock.push(() => ({
      kind: "sse",
      chunks: [
        {
          toolCalls: [
            { index: 0, id: "call_2", name: "write_file", arguments: '{"path":"b.txt","content":"copied"}' },
          ],
          finishReason: "tool_calls",
        },
      ],
    }));
    mock.push(() => ({ kind: "sse", chunks: [{ content: "done", finishReason: "stop" }] }));

    await runWithWorkdir(ws, async () => {
      fs.writeFileSync(path.join(ws, "a.txt"), "source-data");
      const messages: ChatMessage[] = [{ role: "user", content: "copy a to b" }];
      await agentLoop(messages, { loopOptions: quiet });

      // 文件真实生效（mock 指定的 content）
      expect(fs.readFileSync(path.join(ws, "b.txt"), "utf8")).toBe("copied");
      // messages 结构：system + user + 2×(assistant+tool) + assistant(done)
      expect(messages).toHaveLength(7);
      expect(messages[3].role).toBe("tool");
      expect(String(messages[3].content)).toContain("source-data");
      expect(messages[5].role).toBe("tool");
      expect(String(messages[5].content)).toContain("Wrote 6 bytes");
      expect(messages[6].role).toBe("assistant");
    });
  });

  it("权限阻断：sudo 命令的 tool 结果为拒绝原因，loop 继续", async () => {
    mock.push(() => ({
      kind: "sse",
      chunks: [
        {
          toolCalls: [
            { index: 0, id: "call_1", name: "run_bash", arguments: '{"command":"sudo x","run_in_background":false}' },
          ],
          finishReason: "tool_calls",
        },
      ],
    }));
    mock.push(() => ({ kind: "sse", chunks: [{ content: "ok", finishReason: "stop" }] }));

    const messages: ChatMessage[] = [{ role: "user", content: "go" }];
    await agentLoop(messages, { loopOptions: quiet });
    expect(String(messages[3].content)).toContain("deny list");
    expect(messages[4].role).toBe("assistant");
  });

  it("schema 校验阻断：缺参数工具调用返回校验错误", async () => {
    mock.push(() => ({
      kind: "sse",
      chunks: [
        {
          toolCalls: [{ index: 0, id: "call_1", name: "read_file", arguments: "{}" }],
          finishReason: "tool_calls",
        },
      ],
    }));
    mock.push(() => ({ kind: "sse", chunks: [{ content: "ok", finishReason: "stop" }] }));

    const messages: ChatMessage[] = [{ role: "user", content: "go" }];
    await agentLoop(messages, { loopOptions: quiet });
    expect(String(messages[3].content)).toContain("Missing required parameter: path");
  });

  it("请求体携带 tools schema（S5）：含全部内置工具与 strict:true", async () => {
    mock.always(() => ({ kind: "sse", chunks: [{ content: "hi", finishReason: "stop" }] }));
    const messages: ChatMessage[] = [{ role: "user", content: "hello" }];
    await agentLoop(messages, { loopOptions: quiet });
    const req = mock.requests[0];
    expect(req.tools).toBeDefined();
    const names = (req.tools as Array<{ function: { name: string; strict?: boolean } }>).map(
      (t) => t.function.name,
    );
    expect(names).toEqual(
      expect.arrayContaining(["run_bash", "read_file", "write_file", "edit_file", "glob", "todo_write"]),
    );
    const readFile = (req.tools as Array<{ function: { name: string; strict?: boolean } }>).find(
      (t) => t.function.name === "read_file",
    );
    expect(readFile?.function.strict).toBe(true);
  });
});
