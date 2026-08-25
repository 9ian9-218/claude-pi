import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockOpenAI } from "../tests/helpers/mock-openai.ts";
import { installMockModels } from "../tests/helpers/test-client.ts";
import { resetClient, type ChatMessage } from "./client.ts";
import {
  estimateTokens,
  estimateMessageTokens,
  estimateMessagesTokens,
  truncateToTokens,
  persistLargeOutput,
  reactiveCompact,
  compactHistory,
  truncateToolOutput,
  maxOutputReserve,
  getCompactionThreshold,
  estimateContextTokensByUsage,
  pickRetainedTail,
  summarizeHistory,
} from "./compact.ts";
import { runWithWorkdir } from "./workdir.ts";

let mock: MockOpenAI;
let ws: string;

/** 类型化消息构造（测试字面量 → ChatMessage） */
function m(role: ChatMessage["role"], content: string, extra: Record<string, unknown> = {}): ChatMessage {
  return { role, content, ...extra } as unknown as ChatMessage;
}

beforeEach(async () => {
  resetClient();
  mock = await MockOpenAI.create();
  installMockModels(mock.baseUrl);
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pi-compact-"));
});

afterEach(async () => {
  resetClient();
  await mock.close();
  fs.rmSync(ws, { recursive: true, force: true });
});

function userMsg(i: number): ChatMessage {
  return { role: "user", content: `message ${i} ${"x".repeat(20)}` };
}

function round(i: number): ChatMessage[] {
  return [
    {
      role: "assistant",
      content: `reply ${i}`,
      tool_calls: [{ id: `call_${i}`, type: "function", function: { name: "x", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: `call_${i}`, content: `result ${i}` },
  ];
}

describe("estimateTokens（S4）", () => {
  it("中文/英文/其他按启发式加权，至少 1", () => {
    expect(estimateTokens("中文测试")).toBeGreaterThan(0);
    expect(estimateTokens("hello world 123")).toBeGreaterThan(0);
    expect(estimateTokens("")).toBe(1);
  });

  it("estimateMessagesTokens 等于各消息估算之和", () => {
    const msgs = [m("user", "a"), m("user", "bb")];
    expect(estimateMessagesTokens(msgs)).toBe(
      estimateMessageTokens(msgs[0]) + estimateMessageTokens(msgs[1]),
    );
  });
});

describe("truncateToTokens（S4）", () => {
  it("超限时二分截断并加后缀（含后缀估算略超预算）", () => {
    const text = "z".repeat(10_000);
    const out = truncateToTokens(text, 500);
    expect(estimateTokens(out) <= 520).toBe(true);
    expect(out.endsWith("...")).toBe(true);
    expect(out.length).toBeLessThan(text.length);
  });

  it("未超限原样返回", () => {
    expect(truncateToTokens("abc", 500)).toBe("abc");
  });
});

describe("persistLargeOutput（S4）", () => {
  it("超过阈值落盘，未超过原样返回", () => {
    runWithWorkdir(ws, () => {
      const small = "tiny";
      expect(persistLargeOutput("c1", small)).toBe(small);
      const big = "z".repeat(30_000);
      const out = persistLargeOutput("c2", big);
      expect(out).toContain("<persisted-output>");
    });
  });
});

describe("LLM 摘要压缩（S4）", () => {
  it("compactHistory 生成 [Compacted] user 消息（mock 摘要）", async () => {
    mock.always(() => ({ kind: "sse", chunks: [{ content: "总结内容", finishReason: "stop" }] }));
    const out = await compactHistory([userMsg(1), ...round(1)]);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe("user");
    expect(String(out[0].content)).toContain("compacted into the following summary");
    expect(String(out[0].content)).toContain("<summary>");
    expect(String(out[0].content)).toContain("总结内容");
  });

  it("reactiveCompact 保留最近 5 条消息", async () => {
    mock.always(() => ({ kind: "sse", chunks: [{ content: "摘要", finishReason: "stop" }] }));
    const msgs = Array.from({ length: 10 }, (_, i) => userMsg(i));
    const out = await reactiveCompact(msgs);
    expect(out[0].role).toBe("user");
    expect(String(out[0].content)).toContain("compacted into the following summary");
    expect(out).toHaveLength(1 + 5);
  });
});

describe("truncateToolOutput（CC 式单条截断）", () => {
  it(">30K 字符截断 + [N lines truncated] 标记", () => {
    const big = "l".repeat(35_000);
    const out = truncateToolOutput(big);
    expect(out.length).toBeLessThan(30_500);
    expect(out).toMatch(/\[(\d+) lines truncated\]/);
    expect(out).toContain("... [");
  });

  it("未超限原样返回", () => {
    const small = "ok".repeat(100);
    expect(truncateToolOutput(small)).toBe(small);
  });
});

describe("maxOutputReserve / getCompactionThreshold（CC 式触发）", () => {
  it("默认预留 32000；haiku/3-5 模型 8192；env 可覆盖", () => {
    expect(maxOutputReserve("claude-sonnet-4-20250514")).toBe(32_000);
    expect(maxOutputReserve("claude-3-5-sonnet")).toBe(8192);
    expect(maxOutputReserve("claude-haiku-3-5")).toBe(8192);
    process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = "64000";
    try {
      expect(maxOutputReserve("any")).toBe(64_000);
    } finally {
      delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
    }
  });

  it("阈值 = 0.92 × (window − 预留)；pct 可覆盖", () => {
    expect(getCompactionThreshold(128_000)).toBe(Math.round((128_000 - 32_000) * 0.92));
    expect(getCompactionThreshold(1_000_000, 0.95)).toBe(Math.round((1_000_000 - 32_000) * 0.95));
  });
});

describe("estimateContextTokensByUsage（kE 口径）", () => {
  it("取尾部最近带 usage 的 assistant 消息的 prompt tokens", () => {
    const msgs = [
      { role: "user", content: "q" },
      { role: "assistant", content: "a", usage: { input: 100, output: 10, cacheRead: 90, cacheWrite: 5, totalTokens: 205, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
      { role: "tool", tool_call_id: "t", content: "r" },
      { role: "assistant", content: "b", usage: { input: 500, output: 20, cacheRead: 400, cacheWrite: 0, totalTokens: 920, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
    ] as ChatMessage[];
    expect(estimateContextTokensByUsage(msgs)).toBe(500 + 400);
  });

  it("无 usage → null（调用方兜底字符估算）", () => {
    expect(estimateContextTokensByUsage([{ role: "user", content: "hi" }])).toBeNull();
  });
});

describe("pickRetainedTail（keepRecentTokens 预算）", () => {
  it("从尾向前累计不超预算；单条超预算也保留", () => {
    const msgs = [
      { role: "user", content: "a".repeat(50) },
      { role: "assistant", content: "b".repeat(50) },
      { role: "user", content: "c".repeat(50) },
    ] as ChatMessage[];
    const budget = estimateMessageTokens(msgs[1]) + estimateMessageTokens(msgs[2]) + 1;
    const tail = pickRetainedTail(msgs, budget);
    expect(tail).toHaveLength(2);
    expect(tail[0].content).toBe("b".repeat(50));
  });

  it("空或单条", () => {
    expect(pickRetainedTail([], 20000)).toEqual([]);
    const one = [{ role: "user", content: "x" }] as ChatMessage[];
    expect(pickRetainedTail(one, 1)).toEqual(one);
  });
});

describe("summarizeHistory pi 式更新（previousSummary）", () => {
  it("首次压缩：请求体含 <conversation> 包装与 7 节模板关键词", async () => {
    mock.always(() => ({ kind: "sse", chunks: [{ content: "## Goal\n继续工作", finishReason: "stop" }] }));
    const msgs = [userMsg(1), ...round(1)];
    const { summary } = await summarizeHistory(msgs);
    expect(summary).toContain("## Goal");
    const req = mock.requests[0];
    const body = JSON.stringify(req.messages);
    expect(body).toContain("<conversation>");
    expect(body).toContain("## Key Decisions");
    expect(body).not.toContain("<previous-summary>");
  });

  it("第二次压缩：previousSummary 传入，请求体含 <previous-summary> 与更新式指令", async () => {
    mock.always(() => ({ kind: "sse", chunks: [{ content: "## Goal\n更新后", finishReason: "stop" }] }));
    const msgs = [userMsg(2)];
    await summarizeHistory(msgs, { previousSummary: "## Goal\n旧目标" });
    const body = JSON.stringify(mock.requests[0].messages);
    expect(body).toContain("<previous-summary>");
    expect(body).toContain("旧目标");
    expect(body).toContain("Preserve existing goals");
    expect(body).toContain("PRESERVE all existing information");
  });

  it("instructions → Additional focus 后缀", async () => {
    mock.always(() => ({ kind: "sse", chunks: [{ content: "s", finishReason: "stop" }] }));
    await summarizeHistory([userMsg(3)], { instructions: "关注 typescript 改动" });
    const body = JSON.stringify(mock.requests[0].messages);
    expect(body).toContain("Additional focus: 关注 typescript 改动");
  });
});
