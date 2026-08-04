import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MockOpenAI } from "../tests/helpers/mock-openai.ts";
import { resetClient, type ChatMessage } from "./client.ts";
import { agentLoop } from "./agent-loop.ts";
import { LoopOptions } from "./loop-options.ts";
import { registerHook, HOOKS } from "./hook.ts";

const originalEnv = { ...process.env };
let mock: MockOpenAI;

beforeEach(async () => {
  process.env = { ...originalEnv };
  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_MODEL = "gpt-test";
  resetClient();
  mock = await MockOpenAI.create();
  process.env.OPENAI_BASE_URL = mock.baseUrl;
});

afterEach(async () => {
  process.env = { ...originalEnv };
  await mock.close();
  for (const event of Object.keys(HOOKS)) {
    HOOKS[event] = [];
  }
  HOOKS["UserPromptSubmit"] = [];
  HOOKS["Stop"] = [];
});

describe("agentLoop（S2）", () => {
  it("完整回合：user→assistant，Stop hook 触发", async () => {
    mock.always(() => ({ kind: "sse", chunks: [{ content: "Hello!", finishReason: "stop" }] }));
    const messages: ChatMessage[] = [{ role: "user", content: "hi" }];
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));
    try {
      const result = await agentLoop(messages, { loopOptions: new LoopOptions({ quietOutput: true }) });
      expect(result).toBeNull();
    } finally {
      console.log = origLog;
    }
    expect(messages).toHaveLength(3);
    expect(messages[0].role).toBe("system");
    expect(messages[1].role).toBe("user");
    expect(messages[2].role).toBe("assistant");
    expect(messages[2].content).toBe("Hello!");
    expect(logs.some((l) => l.includes("[HOOK] Stop: session used 0 tool calls"))).toBe(true);
  });

  it("max_turn 兜底：持续 tool_calls（未知工具→错误结果）后停止", async () => {
    mock.always(() => ({
      kind: "sse",
      chunks: [
        {
          toolCalls: [{ index: 0, id: "call_1", name: "ghost_tool", arguments: "{}" }],
          finishReason: "tool_calls",
        },
      ],
    }));
    const messages: ChatMessage[] = [{ role: "user", content: "go" }];
    await agentLoop(messages, { maxTurn: 3, loopOptions: new LoopOptions({ quietOutput: true }) });
    // 1 system + 1 user + 3 × (1 assistant + 1 tool error)
    expect(messages).toHaveLength(8);
    expect(messages[3].role).toBe("tool");
    expect(String(messages[3].content)).toContain("Unknown tool: ghost_tool");
  });

  it("Stop hook 返回 force 时追加 user 消息并继续循环", async () => {
    mock.push(() => ({ kind: "sse", chunks: [{ content: "first", finishReason: "stop" }] }));
    mock.push(() => ({ kind: "sse", chunks: [{ content: "second", finishReason: "stop" }] }));
    let forced = false;
    registerHook("Stop", () => {
      if (forced) return undefined;
      forced = true;
      return "force-turn";
    });
    const messages: ChatMessage[] = [{ role: "user", content: "go" }];
    await agentLoop(messages, { loopOptions: new LoopOptions({ quietOutput: true }) });
    expect(forced).toBe(true);
    expect(messages).toHaveLength(5);
    expect(messages[3]).toEqual({ role: "user", content: "force-turn" });
    expect(messages[4].role).toBe("assistant");
    expect(messages[4].content).toBe("second");
  });

  it("exit_on_final_content（子 agent 语义）返回最终内容", async () => {
    mock.always(() => ({ kind: "sse", chunks: [{ content: "done", finishReason: "stop" }] }));
    const messages: ChatMessage[] = [{ role: "user", content: "task" }];
    const result = await agentLoop(messages, { loopOptions: LoopOptions.subagent() });
    expect(result).toBe("done");
    expect(messages).toHaveLength(3);
  });
});
