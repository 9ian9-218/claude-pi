import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockOpenAI } from "../tests/helpers/mock-openai.ts";
import { installMockModels, makeCompletionsModel } from "../tests/helpers/test-client.ts";
import { resetClient, type ChatMessage } from "./client.ts";
import { DEFAULT_RETRY, setSettingsOverrideForTest } from "./settings.ts";
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
  resolveContextWindow,
  retainedTailBudget,
  summaryOutputBudget,
  summarizeInputCap,
  DEFAULT_CONTEXT_WINDOW,
  COMPACTION_RATIOS,
  compactContext,
} from "./compact.ts";
import { runWithWorkdir } from "./workdir.ts";
import { SessionManager, setSessionRoot } from "./session-manager.ts";

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
    expect(out).toHaveLength(3);
    expect(out.slice(1)).toEqual(round(1)); // 工具调用和结果完整保留
    expect(out[0].role).toBe("user");
    expect(String(out[0].content)).toContain("compacted into the following summary");
    expect(String(out[0].content)).toContain("<summary>");
    expect(String(out[0].content)).toContain("总结内容");
  });

  it("reactiveCompact 使用安全切分，保留最新用户回合", async () => {
    mock.always(() => ({ kind: "sse", chunks: [{ content: "摘要", finishReason: "stop" }] }));
    const msgs = Array.from({ length: 10 }, (_, i) => userMsg(i));
    const out = await reactiveCompact(msgs);
    expect(out[0].role).toBe("user");
    expect(String(out[0].content)).toContain("compacted into the following summary");
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual(msgs[9]);
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

describe("阈值派生：窗口 → 输出预留 → 触发线（不写死 token 数）", () => {
  /** 构造指定窗口/maxTokens 的模型（基座 = 测试用 chat-completions 模型） */
  const model = (over: { contextWindow?: number; maxTokens?: number } = {}) => ({
    ...makeCompletionsModel("gpt-test", "http://127.0.0.1:1"),
    ...over,
  });

  it("窗口取模型真实值；读不到 → 256K 兜底", () => {
    expect(resolveContextWindow(model({ contextWindow: 200_000 }))).toBe(200_000);
    expect(resolveContextWindow(model({ contextWindow: 0 }))).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(resolveContextWindow(null)).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(DEFAULT_CONTEXT_WINDOW).toBe(256_000);
  });

  it("输出预留取模型真实 maxTokens，收敛到应用单次输出上限与窗口", () => {
    expect(maxOutputReserve(model({ maxTokens: 8_000 }))).toBe(8_000);
    // 模型报得过大（200K）→ 收敛到应用上限 64K
    expect(maxOutputReserve(model({ maxTokens: 200_000 }))).toBe(64_000);
    // 病态模型（maxTokens ≥ 窗口）→ 预留不超过半个窗口，否则触发线会塌成 1
    const bad = model({ contextWindow: 32_000, maxTokens: 64_000 });
    expect(maxOutputReserve(bad)).toBe(16_000);
    expect(getCompactionThreshold(undefined, undefined, bad)).toBe(Math.round((32_000 - 16_000) * 0.92));
  });

  it("模型未报 maxTokens（缺失/非法）→ 按窗口比例预留（16%）", () => {
    expect(maxOutputReserve(model({ contextWindow: 128_000, maxTokens: 0 }))).toBe(
      Math.round(128_000 * COMPACTION_RATIOS.outputReserve),
    );
    expect(maxOutputReserve(null)).toBe(Math.round(DEFAULT_CONTEXT_WINDOW * COMPACTION_RATIOS.outputReserve));
  });

  it("env / settings.compaction.reserveTokens 显式覆盖优先", () => {
    process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = "12345";
    try {
      expect(maxOutputReserve(model({ maxTokens: 8_000 }))).toBe(12_345);
    } finally {
      delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
    }
    setSettingsOverrideForTest({ retry: DEFAULT_RETRY, compaction: { reserveTokens: 20_000 } });
    try {
      expect(maxOutputReserve(model({ maxTokens: 8_000 }))).toBe(20_000);
    } finally {
      setSettingsOverrideForTest(null);
    }
  });

  it("触发线 = 0.92 × (窗口 − 预留)；窗口缺省取模型、读不到用 256K", () => {
    const m128 = model({ contextWindow: 128_000, maxTokens: 8_000 });
    expect(getCompactionThreshold(undefined, undefined, m128)).toBe(
      Math.round((128_000 - 8_000) * 0.92),
    );
    const m1m = model({ contextWindow: 1_000_000, maxTokens: 128_000 });
    expect(getCompactionThreshold(undefined, 0.95, m1m)).toBe(
      Math.round((1_000_000 - 64_000) * 0.95),
    );
    const fallbackReserve = Math.round(DEFAULT_CONTEXT_WINDOW * COMPACTION_RATIOS.outputReserve);
    expect(getCompactionThreshold(undefined, undefined, null)).toBe(
      Math.round((DEFAULT_CONTEXT_WINDOW - fallbackReserve) * 0.92),
    );
  });

  it("retainedTail 预算固定 20K（不随窗口缩放）；settings 可覆盖", () => {
    expect(retainedTailBudget()).toBe(20_000);
    setSettingsOverrideForTest({ retry: DEFAULT_RETRY, compaction: { keepRecentTokens: 5_000 } });
    try {
      expect(retainedTailBudget()).toBe(5_000);
    } finally {
      setSettingsOverrideForTest(null);
    }
  });

  it("摘要预算随窗口缩放，且收敛到模型 maxTokens / 应用输出上限", () => {
    const m200 = model({ contextWindow: 200_000, maxTokens: 64_000 });
    expect(summaryOutputBudget(m200)).toBe(20_000);
    expect(summarizeInputCap(m200)).toBe(180_000);
    const m256 = model({ contextWindow: 256_000, maxTokens: 64_000 });
    expect(summarizeInputCap(m256)).toBe(256_000 - 25_600);
    // 小输出模型：不超它的 maxTokens（否则 max_tokens 超限 → provider 400）
    expect(summaryOutputBudget(model({ contextWindow: 128_000, maxTokens: 8_000 }))).toBe(8_000);
    // 大窗口：不超应用单次输出上限
    expect(summaryOutputBudget(model({ contextWindow: 1_000_000, maxTokens: 128_000 }))).toBe(64_000);
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
    expect(estimateContextTokensByUsage(msgs)).toBe(500 + 400 + 20);
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
    const budget = estimateMessageTokens(msgs[1]) + estimateMessageTokens(msgs[2]);
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

describe("compactContext（手动 /compact 与自动压缩共用的执行体）", () => {
  const usage = (input: number) => ({
    input,
    output: 10,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + 10,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });

  it("会话路径：写 compaction entry，上下文按检查点重建，instructions 进摘要 prompt", async () => {
    setSessionRoot(ws);
    mock.always(() => ({ kind: "sse", chunks: [{ content: "手动摘要", finishReason: "stop" }] }));
    const session = SessionManager.create(ws);
    session.appendMessage({ role: "user", content: "最初的提问" });
    session.appendMessage({ role: "assistant", content: "回答", usage: usage(500) });
    session.appendMessage({ role: "user", content: "最新一句" });
    const messages = session.buildSessionContext().messages;

    const out = await compactContext(messages, { session, instructions: "只保留 bug 线索" });

    // 口径 = 真实 usage（kE）
    expect(out.tokensBefore).toBe(520);
    const comp = session.getEntries().find((e) => e.type === "compaction") as
      | { summary: string; retainedTail?: ChatMessage[] }
      | undefined;
    expect(comp).toBeDefined();
    expect(comp?.summary).toContain("手动摘要");
    expect(comp?.retainedTail?.length).toBeGreaterThan(0);
    // 调用方持有的 messages 被就地替换为检查点视图
    const contents = messages.map((m) => String(m.content));
    expect(contents[0]).toContain("compacted into the following summary");
    expect(contents).toContain("最新一句");
    // 额外指令透传
    const last = mock.requests[mock.requests.length - 1];
    const prompt = last.messages.map((m: { content?: unknown }) => String(m.content)).join("\n");
    expect(prompt).toContain("Additional focus: 只保留 bug 线索");
  });

  it("非会话路径：摘要加保留尾巴（无 compaction entry）", async () => {
    mock.always(() => ({ kind: "sse", chunks: [{ content: "摘要内容", finishReason: "stop" }] }));
    const messages: ChatMessage[] = [m("user", "a"), m("user", "b")];
    const out = await runWithWorkdir(ws, () => compactContext(messages, {}));
    expect(out.tokensBefore).toBeGreaterThan(0);
    expect(messages).toHaveLength(2);
    expect(messages[1].content).toBe("b");
    expect(String(messages[0].content)).toContain("<summary>");
    expect(String(messages[0].content)).toContain("摘要内容");
  });

  it("同前缀的两条分支：第二次压缩复用已有摘要（不调 API），并记录 reusedFrom", async () => {
    setSessionRoot(ws);
    let calls = 0;
    mock.always(() => ({ kind: "sse", chunks: [{ content: `摘要${++calls}`, finishReason: "stop" }] }));
    const session = SessionManager.create(ws);
    session.appendMessage({ role: "user", content: "共同的开头" });
    session.appendMessage({ role: "assistant", content: "共同的回答" });
    const forkPoint = session.getLeafId() as string;

    // 分支 A：就地压缩（覆盖「根…分叉点」）
    await compactContext(session.buildSessionContext().messages, { session });
    const first = session
      .getEntries()
      .find((e) => e.type === "compaction") as { id: string; summary: string; inputHash?: string };

    // 回到分叉点 → 分支 B 的前缀与 A 一字不差
    session.branch(forkPoint);
    const out = await compactContext(session.buildSessionContext().messages, { session });
    const compactions = session
      .getEntries()
      .filter((e) => e.type === "compaction") as Array<{
      id: string;
      summary: string;
      inputHash?: string;
      reusedFrom?: string;
    }>;

    expect(mock.requests).toHaveLength(1); // 只调用了一次摘要 API
    expect(compactions).toHaveLength(2);
    expect(compactions[1].summary).toBe(compactions[0].summary);
    expect(compactions[1].reusedFrom).toBe(first.id);
    expect(compactions[1].inputHash).toBe(first.inputHash);
    expect(out.reusedFrom).toBe(first.id);
  });

  it("前缀不同的分支（各自先说话再压）：不复用，各自调用 API", async () => {
    setSessionRoot(ws);
    let calls = 0;
    mock.always(() => ({ kind: "sse", chunks: [{ content: `摘要${++calls}`, finishReason: "stop" }] }));
    const session = SessionManager.create(ws);
    session.appendMessage({ role: "user", content: "共同开头" });
    const forkPoint = session.getLeafId() as string;

    session.appendMessage({ role: "user", content: "A 的问题" });
    session.appendMessage({ role: "assistant", content: "A 的已执行进度" });
    session.appendMessage({ role: "user", content: "继续" });
    await compactContext(session.buildSessionContext().messages, { session });
    session.branch(forkPoint);
    session.appendMessage({ role: "user", content: "B 的问题" });
    session.appendMessage({ role: "assistant", content: "B 的已执行进度" });
    session.appendMessage({ role: "user", content: "继续" });
    await compactContext(session.buildSessionContext().messages, { session });

    expect(mock.requests).toHaveLength(2);
    const compactions = session.getEntries().filter((e) => e.type === "compaction") as Array<{
      reusedFrom?: string;
    }>;
    expect(compactions).toHaveLength(2);
    expect(compactions.every((c) => c.reusedFrom === undefined)).toBe(true);
  });

  it("摘要失败：抛错且不写 compaction entry", async () => {
    setSessionRoot(ws);
    mock.always(() => ({ kind: "error", status: 500, body: "boom" }));
    const session = SessionManager.create(ws);
    session.appendMessage({ role: "user", content: "问题" });
    const messages = session.buildSessionContext().messages;

    await expect(compactContext(messages, { session })).rejects.toThrow();
    expect(session.getEntries().some((e) => e.type === "compaction")).toBe(false);
    // 失败不动调用方上下文
    expect(messages.map((x) => String(x.content))).toContain("问题");
  });
});
