import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MockOpenAI } from "../tests/helpers/mock-openai.ts";
import { sendMessages, resetClient, type ChatMessage } from "./client.ts";

const originalEnv = { ...process.env };
let mock: MockOpenAI;

beforeEach(async () => {
  process.env = { ...originalEnv };
  resetClient();
  mock = await MockOpenAI.create();
  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = mock.baseUrl;
  process.env.OPENAI_MODEL = "gpt-test";
});

afterEach(async () => {
  process.env = { ...originalEnv };
  await mock.close();
});

function plainMessages(): ChatMessage[] {
  return [{ role: "user", content: "hello" }];
}

describe("sendMessages 流式（S1）", () => {
  it("聚合流式 content 并返回 finish_reason", async () => {
    mock.always(() => ({
      kind: "sse",
      chunks: [
        { content: "Hel" },
        { content: "lo" },
        { finishReason: "stop" },
      ],
    }));
    const result = await sendMessages(plainMessages(), { quietOutput: true });
    expect(result.content).toBe("Hello");
    expect(result.finishReason).toBe("stop");
    expect(result.needsFollowUp).toBe(false);
    expect(result.toolCalls).toBeNull();
  });

  it("tool_calls 增量聚合（同 index 累积 arguments）", async () => {
    mock.always(() => ({
      kind: "sse",
      chunks: [
        {
          toolCalls: [{ index: 0, id: "call_1", name: "read_file", arguments: "{\"path\":" }],
        },
        { toolCalls: [{ index: 0, arguments: "\"a.txt\"}" }] },
        { finishReason: "tool_calls" },
      ],
    }));
    const result = await sendMessages(plainMessages(), { quietOutput: true });
    expect(result.needsFollowUp).toBe(true);
    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].id).toBe("call_1");
    expect(result.toolCalls![0].function.name).toBe("read_file");
    expect(result.toolCalls![0].function.arguments).toBe('{"path":"a.txt"}');
  });

  it("请求体携带 model/stream/max_tokens", async () => {
    mock.always(() => ({ kind: "sse", chunks: [{ content: "ok", finishReason: "stop" }] }));
    await sendMessages(plainMessages(), { quietOutput: true, maxTokens: 1234 });
    const req = mock.requests[0];
    expect(req.model).toBe("gpt-test");
    expect(req.stream).toBe(true);
    expect(req.max_tokens).toBe(1234);
    expect(req.messages[0].role).toBe("system");
    expect(req.messages[1].role).toBe("user");
  });

  it("_ensureSystem：无 system 时插入组装好的 system 消息", async () => {
    mock.always(() => ({ kind: "sse", chunks: [{ content: "ok", finishReason: "stop" }] }));
    const messages = plainMessages();
    await sendMessages(messages, { quietOutput: true });
    expect(messages[0].role).toBe("system");
    expect(String(messages[0].content)).toContain("You are a coding agent at");
    const req = mock.requests[0];
    expect(req.messages[0].role).toBe("system");
  });

  it("preserve_system：不替换已有 system 消息", async () => {
    mock.always(() => ({ kind: "sse", chunks: [{ content: "ok", finishReason: "stop" }] }));
    const messages: ChatMessage[] = [
      { role: "system", content: "custom system" },
      { role: "user", content: "hi" },
    ];
    await sendMessages(messages, { quietOutput: true, preserveSystem: true });
    const req = mock.requests[0];
    expect(req.messages[0].content).toBe("custom system");
  });

  it("quiet_output 时不打印 Model > 前缀", async () => {
    const logs: string[] = [];
    const orig = process.stdout.write;
    process.stdout.write = ((chunk: unknown) => {
      logs.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      mock.always(() => ({ kind: "sse", chunks: [{ content: "hi", finishReason: "stop" }] }));
      await sendMessages(plainMessages(), { quietOutput: true });
      expect(logs.join("")).not.toContain("Model >");
    } finally {
      process.stdout.write = orig;
    }
  });
});
