import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockOpenAI } from "../tests/helpers/mock-openai.ts";
import { installMockModels, makeCompletionsModel } from "../tests/helpers/test-client.ts";
import { resetClient, type ChatMessage } from "./client.ts";
import { setCurrentModel } from "./ai-runtime.ts";
import { setSettingsOverrideForTest } from "./settings.ts";
import { SessionManager, setSessionRoot, type CompactionEntry } from "./session-manager.ts";
import { runWithWorkdir } from "./workdir.ts";
import {
  compactContext, estimateMessagesTokens, findCompactionCutPoint, getCompactionThreshold,
  maybeCompact, prepareCompaction, reactiveCompact,
} from "./compact.ts";
import { RecoveryState, sendMessagesWithRecovery } from "./error-recovery.ts";
import { TaskBudget, runWithBudget, BudgetExceeded } from "./task-budget.ts";

let mock: MockOpenAI;
let ws: string;
beforeEach(async () => {
  resetClient();
  mock = await MockOpenAI.create();
  installMockModels(mock.baseUrl);
  setCurrentModel(makeCompletionsModel("gpt-test", mock.baseUrl));
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "cpi-split-turn-"));
  setSessionRoot(ws);
});
afterEach(async () => {
  resetClient();
  await mock.close();
  fs.rmSync(ws, { recursive: true, force: true });
});

const user = (content: string): ChatMessage => ({ role: "user", content });
const answer = (content: string): ChatMessage => ({ role: "assistant", content });
const call = (...ids: string[]): ChatMessage => ({
  role: "assistant", content: "",
  tool_calls: ids.map(id => ({ id, type: "function", function: { name: "read_file", arguments: "{}" } })),
});
const result = (id: string, content: string): ChatMessage => ({ role: "tool", tool_call_id: id, content });
function fixture(): ChatMessage[] {
  return [user("old-goal"), answer("old-answer"), user("current-request"),
    call("early"), result("early", "early-result"),
    call("recent-a", "recent-b"), result("recent-a", "recent-result-a"), result("recent-b", "recent-result-b")];
}
function configureTail(messages: ChatMessage[], start = 5): number {
  const keepRecentTokens = estimateMessagesTokens(messages.slice(start));
  setSettingsOverrideForTest({ retry: { enabled: true, maxRetries: 0, baseDelayMs: 1 }, compaction: { keepRecentTokens } });
  return keepRecentTokens;
}
function makeSession(messages: ChatMessage[]): SessionManager {
  const session = SessionManager.create(ws);
  for (const message of messages) session.appendMessage(message);
  return session;
}
function checkpoint(session: SessionManager): CompactionEntry {
  return session.getEntries().filter(e => e.type === "compaction").at(-1) as CompactionEntry;
}
function reply(text: string): void {
  mock.push(() => ({ kind: "sse", chunks: [{ content: text, finishReason: "stop" }] }));
}
function prompt(index: number): string {
  return String(mock.requests[index].messages[0].content);
}

describe("pi 安全切分边界", () => {
  it("将旧历史、当前回合前缀和保留后缀分开且不重叠", () => {
    const messages = fixture();
    const plan = prepareCompaction(messages, configureTail(messages));
    expect(plan).toMatchObject({ firstKeptIndex: 5, turnStartIndex: 2, isSplitTurn: true });
    expect(plan.messagesToSummarize).toEqual(messages.slice(0, 2));
    expect(plan.turnPrefixMessages).toEqual(messages.slice(2, 5));
    expect(plan.retainedTail).toEqual(messages.slice(5));
  });

  it.each([1, 20, 80, 200, 500])("预算 %i 不留下孤立或部分工具结果", budget => {
    const messages = fixture();
    const cut = findCompactionCutPoint(messages, budget);
    const tail = messages.slice(cut.firstKeptIndex);
    expect(tail[0].role).not.toBe("tool");
    const calls = tail.filter(m => m.role === "assistant").flatMap(m => m.tool_calls ?? []) as { id: string }[];
    expect(tail.filter(m => m.role === "tool").every(m => calls.some(c => c.id === m.tool_call_id))).toBe(true);
    for (const c of calls) expect(tail.some(m => m.role === "tool" && m.tool_call_id === c.id)).toBe(true);
  });

  it("在用户回合边界切分不生成 turn-prefix 摘要", () => {
    const messages = [...fixture(), user("new-request")];
    const plan = prepareCompaction(messages, estimateMessagesTokens(messages.slice(-1)));
    expect(plan.isSplitTurn).toBe(false);
    expect(plan.turnPrefixMessages).toEqual([]);
    expect(plan.retainedTail).toEqual(messages.slice(-1));
  });

  it("拒绝孤立结果或尚未完成的工具轮，不把未知执行当作摘要", () => {
    expect(() => prepareCompaction([user("q"), result("orphan", "r")], 1)).toThrow(/orphan/);
    expect(() => prepareCompaction([user("q"), call("pending")], 1)).toThrow(/incomplete/);
    expect(() => prepareCompaction([user("q"), call("a", "b"), result("a", "r")], 1)).toThrow(/incomplete/);
  });
});

describe("split-turn 摘要与树形恢复", () => {
  it("分别请求两份摘要，汇总用量，重启恢复完整保留工具轮及模型设置", async () => {
    const original = fixture();
    configureTail(original);
    const session = SessionManager.create(ws);
    session.appendModelChange("deepseek", "model-for-restore");
    session.appendThinkingChange("medium");
    for (const m of original) session.appendMessage(m);
    const messages = session.buildSessionContext().messages;
    reply("history-summary"); reply("turn-prefix-summary");
    const outcome = await compactContext(messages, { session, instructions: "preserve file paths" });

    expect(outcome.isSplitTurn).toBe(true);
    expect(mock.requests).toHaveLength(2);
    expect(prompt(0)).toContain("old-goal");
    expect(prompt(0)).not.toContain("current-request");
    expect(prompt(1)).toContain("PREFIX of a turn");
    expect(prompt(1)).toContain("current-request");
    expect(prompt(1)).toContain("early-result");
    expect(prompt(1)).not.toContain("recent-result-a");
    expect(prompt(1)).toContain("Additional focus: preserve file paths");
    expect(checkpoint(session)).toMatchObject({ isSplitTurn: true, reason: "manual", usage: { input: 10, output: 14, totalTokens: 24 } });
    expect(messages.slice(1)).toEqual(original.slice(5));
    expect(messages[0].content).toContain("**Turn Context (split turn):**");
    expect(messages[0].content).toContain("history-summary");
    expect(messages[0].content).toContain("turn-prefix-summary");

    const restored = SessionManager.open(session.getSessionFile()!).buildSessionContext();
    expect(restored.messages).toEqual(messages);
    expect(restored.model).toBe("deepseek/model-for-restore");
    expect(restored.thinkingLevel).toBe("medium");
  });

  it("单个大回合只摘要前缀，不额外请求空历史", async () => {
    const original = fixture().slice(2);
    configureTail(original, 3);
    reply("prefix-only");
    const messages = [...original];
    await runWithWorkdir(ws, () => compactContext(messages));
    expect(mock.requests).toHaveLength(1);
    expect(prompt(0)).toContain("Original Request");
    expect(messages[0].content).toContain("prefix-only");
    expect(messages.slice(1)).toEqual(original.slice(3));
  });

  it("当前回合完整保留时只请求历史摘要", async () => {
    const original = [...fixture(), user("next-request")];
    configureTail(original, original.length - 1);
    const session = makeSession(original);
    reply("history-only");
    const messages = session.buildSessionContext().messages;
    await compactContext(messages, { session });
    expect(mock.requests).toHaveLength(1);
    expect(checkpoint(session).isSplitTurn).toBe(false);
    expect(messages.slice(1)).toEqual([user("next-request")]);
  });

  it("相同摘要输入复用两份合并摘要，分支后缀仍各自保存", async () => {
    const original = fixture();
    configureTail(original);
    const session = makeSession(original.slice(0, 5));
    const branchPoint = session.getLeafId()!;
    for (const m of original.slice(5)) session.appendMessage(m);
    reply("history"); reply("prefix");
    await compactContext(session.buildSessionContext().messages, { session });
    const first = checkpoint(session);
    session.branch(branchPoint);
    const otherTail = [original[5], result("recent-a", "branch-result-a"), result("recent-b", "branch-result-b")];
    for (const m of otherTail) session.appendMessage(m);
    const messages = session.buildSessionContext().messages;
    const outcome = await compactContext(messages, { session });
    expect(mock.requests).toHaveLength(2);
    expect(outcome.reusedFrom).toBe(first.id);
    expect(checkpoint(session).summary).toBe(first.summary);
    expect(checkpoint(session).usage).toBeUndefined();
    expect(messages.slice(1)).toEqual(otherTail);
  });

  it("第二次压缩更新已有摘要，不再次摘要已丢弃的原始历史", async () => {
    const original = fixture();
    configureTail(original);
    const session = makeSession(original);
    reply("history-summary"); reply("prefix-summary");
    await compactContext(session.buildSessionContext().messages, { session });
    session.appendMessage(answer("recent work completed"));
    session.appendMessage(user("next-request"));
    const messages = session.buildSessionContext().messages;
    configureTail(messages, messages.length - 1);
    reply("updated-summary");
    await compactContext(messages, { session });
    expect(mock.requests).toHaveLength(3);
    expect(prompt(2)).toContain("<previous-summary>");
    expect(prompt(2)).toContain("prefix-summary");
    expect(prompt(2)).not.toContain("old-goal");
    expect(messages.slice(1)).toEqual([user("next-request")]);
  });

  it("第二份摘要失败不写检查点，也不修改原上下文", async () => {
    const original = fixture();
    configureTail(original);
    const session = makeSession(original);
    const messages = session.buildSessionContext().messages;
    const leaf = session.getLeafId();
    reply("history");
    mock.push(() => ({ kind: "error", status: 400, body: "prefix failed" }));
    await expect(compactContext(messages, { session })).rejects.toThrow();
    expect(messages).toEqual(original);
    expect(session.getLeafId()).toBe(leaf);
    expect(checkpoint(session)).toBeUndefined();
  });

  it("两段摘要共享请求预算，预算不足时不写部分检查点", async () => {
    const original = fixture();
    configureTail(original);
    const session = makeSession(original);
    const messages = session.buildSessionContext().messages;
    const budget = new TaskBudget({ requests: 1 });
    reply("history");
    try {
      await expect(runWithBudget(budget, () => compactContext(messages, { session }))).rejects.toBeInstanceOf(BudgetExceeded);
      expect(mock.requests).toHaveLength(1);
      expect(budget.usage.requests).toBe(1);
      expect(checkpoint(session)).toBeUndefined();
      expect(messages).toEqual(original);
    } finally { budget.dispose(); }
  });

  it("第二份摘要中取消不会提交部分摘要", async () => {
    const original = fixture();
    configureTail(original);
    const session = makeSession(original);
    const messages = session.buildSessionContext().messages;
    const controller = new AbortController();
    reply("history");
    mock.push(() => {
      controller.abort(new Error("cancel split summary"));
      return { kind: "sse", chunks: [{ content: "prefix", finishReason: "stop" }] };
    });
    await expect(compactContext(messages, { session, signal: controller.signal })).rejects.toThrow();
    expect(messages).toEqual(original);
    expect(checkpoint(session)).toBeUndefined();
  });

  it("压缩期间切换分支不会把旧分支摘要写进新分支", async () => {
    const original = fixture();
    configureTail(original);
    const session = makeSession(original);
    const messages = session.buildSessionContext().messages;
    reply("history");
    mock.push(() => {
      session.branch(session.getEntries()[0].id);
      return { kind: "sse", chunks: [{ content: "prefix", finishReason: "stop" }] };
    });
    await expect(compactContext(messages, { session })).rejects.toThrow(/Session changed/);
    expect(checkpoint(session)).toBeUndefined();
    expect(messages).toEqual(original);
  });

  it("空尾巴检查点不会在重新打开时带回旧原文", async () => {
    const session = makeSession([user("single-old-request")]);
    reply("summary-only");
    const messages = session.buildSessionContext().messages;
    await compactContext(messages, { session });
    expect(checkpoint(session).retainedTail).toEqual([]);
    const restored = SessionManager.open(session.getSessionFile()!).buildSessionContext().messages;
    expect(restored).toEqual(messages);
    expect(restored).toHaveLength(1);
    expect(restored[0].content).not.toContain("single-old-request");
  });

  it("自动压缩也使用两段摘要并保存 auto 原因", async () => {
    const original = fixture();
    original[5].usage = { input: getCompactionThreshold() + 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: getCompactionThreshold() + 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    configureTail(original);
    const session = makeSession(original);
    reply("history"); reply("prefix");
    const messages = session.buildSessionContext().messages;
    await maybeCompact(messages, { session });
    expect(checkpoint(session)).toMatchObject({ isSplitTurn: true, reason: "auto" });
    expect(mock.requests).toHaveLength(2);
    expect(messages.slice(1)).toEqual(original.slice(5));
  });

  it("无会话超限恢复同样保留合法工具轮及系统提示", async () => {
    const original = fixture();
    configureTail(original);
    reply("history"); reply("prefix");
    const system: ChatMessage = { role: "system", content: "frozen instructions" };
    const out = await runWithWorkdir(ws, () => reactiveCompact([system, ...original]));
    expect(out[0]).toEqual(system);
    expect(out.slice(2)).toEqual(original.slice(5));
    expect(fs.readdirSync(path.join(ws, ".transcripts"))).toHaveLength(1);
  });

  it("真实 overflow 恢复写检查点，重启后不会重发被摘要的历史", async () => {
    const original = fixture();
    configureTail(original);
    const session = makeSession(original);
    const messages = session.buildSessionContext().messages;
    mock.push(() => ({ kind: "error", status: 400, body: JSON.stringify({ error: { message: "context_length_exceeded" } }) }));
    reply("history"); reply("prefix"); reply("continued");
    const state = new RecoveryState();
    const options = { requestMessages: messages, messages, state, maxTokens: 8000, session, quietOutput: true };
    const first = await sendMessagesWithRecovery(options);
    expect(first.action).toBe("retry");
    expect(checkpoint(session)).toMatchObject({ isSplitTurn: true, reason: "reactive" });
    const restored = SessionManager.open(session.getSessionFile()!).buildSessionContext().messages;
    expect(restored).toEqual(messages.filter(m => m.role !== "system"));
    expect(restored.slice(1)).toEqual(original.slice(5));
    expect((await sendMessagesWithRecovery(options)).action).toBe("success");
    const request = JSON.stringify(mock.requests.at(-1)?.messages);
    expect(request).not.toContain("old-goal");
    expect(request).toContain("recent-result-a");
    expect(request).toContain("prefix");
  });

  it("overflow 后前缀摘要失败返回明确 abort，原会话仍可恢复", async () => {
    const original = fixture();
    configureTail(original);
    const session = makeSession(original);
    const messages = session.buildSessionContext().messages;
    mock.push(() => ({ kind: "error", status: 400, body: JSON.stringify({ error: { message: "prompt is too long" } }) }));
    reply("history");
    mock.push(() => ({ kind: "error", status: 400, body: "prefix failed" }));
    const state = new RecoveryState();
    const outcome = await sendMessagesWithRecovery({ requestMessages: messages, messages, state, maxTokens: 8000, session, quietOutput: true });
    expect(outcome).toMatchObject({ action: "abort", reason: "error", errorMessage: expect.stringContaining("Context compaction failed") });
    expect(state.hasAttemptedReactiveCompact).toBe(true);
    expect(checkpoint(session)).toBeUndefined();
    expect(SessionManager.open(session.getSessionFile()!).buildSessionContext().messages).toEqual(original);
  });
});
