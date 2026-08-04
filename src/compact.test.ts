import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockOpenAI } from "../tests/helpers/mock-openai.ts";
import { resetClient, type ChatMessage } from "./client.ts";
import {
  estimateTokens,
  estimateMessageTokens,
  estimateMessagesTokens,
  snipCompact,
  microCompact,
  toolResultBudget,
  truncateToTokens,
  persistLargeOutput,
  reactiveCompact,
  compactHistory,
  _splitRounds,
  _validateToolPairing,
} from "./compact.ts";
import { runWithWorkdir } from "./workdir.ts";

const originalEnv = { ...process.env };
let mock: MockOpenAI;
let ws: string;

/** 类型化消息构造（测试字面量 → ChatMessage） */
function m(role: ChatMessage["role"], content: string, extra: Record<string, unknown> = {}): ChatMessage {
  return { role, content, ...extra } as unknown as ChatMessage;
}

beforeEach(async () => {
  process.env = { ...originalEnv };
  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_MODEL = "gpt-test";
  resetClient();
  mock = await MockOpenAI.create();
  process.env.OPENAI_BASE_URL = mock.baseUrl;
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pi-compact-"));
});

afterEach(async () => {
  process.env = { ...originalEnv };
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

describe("splitRounds / validateToolPairing（S4）", () => {
  it("assistant+tool_calls 与后续 tool 消息组成一轮", () => {
    const msgs = [
      m("user", "u"),
      m("assistant", "a", {
        tool_calls: [{ id: "c1", type: "function", function: { name: "x", arguments: "{}" } }],
      }),
      m("tool", "r", { tool_call_id: "c1" }),
      m("user", "u2"),
    ];
    const rounds = _splitRounds(msgs);
    expect(rounds).toHaveLength(3);
    expect(rounds[1]).toHaveLength(2); // assistant+tool 同轮
    expect(rounds[1][0].role).toBe("assistant");
    expect(rounds[1][1].role).toBe("tool");
  });

  it("tool pairing 破坏时抛错", () => {
    const msgs = [
      m("assistant", "a", { tool_calls: [{ id: "c1" }] }),
      m("tool", "r", { tool_call_id: "c2" }),
    ];
    expect(() => _validateToolPairing(msgs)).toThrow("tool_call pairing broken");
  });
});

describe("snipCompact（S4, L1）", () => {
  it("消息数未超限时原样返回", () => {
    const msgs: ChatMessage[] = [userMsg(1), ...round(1)];
    expect(snipCompact(msgs)).toBe(msgs);
  });

  it("超限且可裁剪时：裁剪中间、保留首尾完整轮次、插入占位符", () => {
    const msgs: ChatMessage[] = [m("system", "sys")];
    for (let i = 0; i < 130; i++) {
      msgs.push(userMsg(i), ...round(i));
    }
    const out = snipCompact(msgs, 68);
    expect(out.length).toBeLessThanOrEqual(68);
    expect(out[0].role).toBe("system");
    expect(out.some((m) => m.role === "user" && String(m.content).startsWith("[snipped"))).toBe(true);
    // 首尾保留：头部首条 + 尾部最后轮次（assistant/tool；Python 行为）
    expect(out.some((x) => String(x.content).includes("message 0"))).toBe(true);
    expect(out.some((x) => String(x.content).includes("reply 129"))).toBe(true);
    expect(out.some((x) => String(x.content).includes("result 129"))).toBe(true);
    // tool pairing 完好
    expect(() => _validateToolPairing(out)).not.toThrow();
  });

  it("无法放下完整轮次时返回原数组（Python 等价行为）", () => {
    const msgs: ChatMessage[] = [m("system", "sys")];
    for (let i = 0; i < 130; i++) {
      msgs.push(userMsg(i), ...round(i));
    }
    const out = snipCompact(msgs, 63);
    expect(out).toBe(msgs);
  });
});

describe("microCompact（S4, L2）", () => {
  it("旧的大 tool result 替换为占位符，最近 10 条保留", () => {
    const msgs: ChatMessage[] = [];
    for (let i = 0; i < 15; i++) {
      msgs.push(m("tool", "x".repeat(40_000), { tool_call_id: `c${i}` }));
    }
    microCompact(msgs);
    // 前 5 条被替换
    for (let i = 0; i < 5; i++) {
      expect(msgs[i].content).toContain("[Earlier tool result compacted");
    }
    // 最近 10 条保留原文
    for (let i = 5; i < 15; i++) {
      expect(String(msgs[i].content).startsWith("x".repeat(40_000))).toBe(true);
    }
  });

  it("小结果不替换", () => {
    const msgs = [
      m("tool", "small", { tool_call_id: "c1" }),
      m("tool", "tiny", { tool_call_id: "c2" }),
    ];
    microCompact(msgs);
    expect(msgs[0].content).toBe("small");
  });
});

describe("toolResultBudget（S4, L3）", () => {
  it("尾部工具结果超预算时大结果落盘并留预览", () => {
    runWithWorkdir(ws, () => {
      const big = "y".repeat(30_000); // ~8400 tok > 6000 阈值
      const msgs = [
        m("tool", big, { tool_call_id: "big_call" }),
        m("tool", "ok", { tool_call_id: "small_call" }),
      ];
      toolResultBudget(msgs, 1000); // 预算压到 1000 触发
      const replaced = String(msgs[0].content);
      expect(replaced).toContain("<persisted-output>");
      expect(replaced).toContain("tool-results/big_call.txt");
      expect(replaced).toContain("Preview:");
      const persisted = fs.readFileSync(path.join(ws, ".task_outputs", "tool-results", "big_call.txt"), "utf8");
      expect(persisted).toBe(big);
      expect(msgs[1].content).toBe("ok");
    });
  });

  it("总预算未超时原样返回", () => {
    const msgs = [m("tool", "small", { tool_call_id: "c1" })];
    expect(toolResultBudget(msgs)).toBe(msgs);
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
    mock.always(() => ({ kind: "json", content: "总结内容" }));
    const out = await compactHistory([userMsg(1), ...round(1)]);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe("user");
    expect(String(out[0].content)).toContain("[Compacted]");
    expect(String(out[0].content)).toContain("总结内容");
  });

  it("reactiveCompact 保留最近 5 条消息", async () => {
    mock.always(() => ({ kind: "json", content: "摘要" }));
    const msgs = Array.from({ length: 10 }, (_, i) => userMsg(i));
    const out = await reactiveCompact(msgs);
    expect(out[0].role).toBe("user");
    expect(String(out[0].content)).toContain("[Reactive compact]");
    expect(out).toHaveLength(1 + 5);
  });
});
