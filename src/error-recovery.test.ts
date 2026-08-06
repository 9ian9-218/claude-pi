import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MockOpenAI } from "../tests/helpers/mock-openai.ts";
import { installMockModels } from "../tests/helpers/test-client.ts";
import { resetClient, type ChatMessage } from "./client.ts";
import {
  RecoveryState,
  getRetryPolicy,
  setRetryPolicyForTest,
  sendMessagesWithRecovery,
  ESCALATED_MAX_TOKENS,
  MAX_RECOVERY_RETRIES,
} from "./error-recovery.ts";

let mock: MockOpenAI;

beforeEach(async () => {
  resetClient();
  mock = await MockOpenAI.create();
  installMockModels(mock.baseUrl);
});

afterEach(async () => {
  resetClient();
  setRetryPolicyForTest(null);
  await mock.close();
});

function plain(): ChatMessage[] {
  return [{ role: "user", content: "hi" }];
}

describe("retry 策略（S3，ADR-0007：pi settings retry 键）", () => {
  it("getRetryPolicy 默认值与 pi 一致（enabled/3/2000）", () => {
    setRetryPolicyForTest(null);
    const p = getRetryPolicy();
    expect(p.enabled).toBe(true);
    expect(p.maxRetries).toBe(3);
    expect(p.baseDelayMs).toBe(2000);
  });

  it("429 重试后成功（指数退避，pi retryAssistantCall）", async () => {
    setRetryPolicyForTest({ enabled: true, maxRetries: 2, baseDelayMs: 1 });
    mock.push(() => ({
      kind: "error",
      status: 429,
      body: JSON.stringify({ error: { message: "429 rate limit" } }),
    }));
    mock.push(() => ({
      kind: "error",
      status: 429,
      body: JSON.stringify({ error: { message: "429 rate limit" } }),
    }));
    mock.push(() => ({ kind: "sse", chunks: [{ content: "ok", finishReason: "stop" }] }));
    const state = new RecoveryState();
    const messages = plain();
    const result = await sendMessagesWithRecovery({
      requestMessages: messages,
      messages,
      state,
      maxTokens: 8000,
    });
    expect(result.action).toBe("success");
    expect(mock.requests).toHaveLength(3);
  });

  it("非暂时性错误不重试（pi isRetryableAssistantError）", async () => {
    setRetryPolicyForTest({ enabled: true, maxRetries: 5, baseDelayMs: 1 });
    mock.always(() => ({
      kind: "error",
      status: 400,
      body: JSON.stringify({ error: { message: "boom" } }),
    }));
    const state = new RecoveryState();
    const messages = plain();
    const result = await sendMessagesWithRecovery({
      requestMessages: messages,
      messages,
      state,
      maxTokens: 8000,
    });
    expect(result.action).toBe("abort");
    expect(mock.requests).toHaveLength(1);
    expect(String(messages[messages.length - 1].content)).toContain("[Error]");
  });
});

describe("sendMessagesWithRecovery（S3）", () => {
  it("成功返回 success + message", async () => {
    mock.always(() => ({ kind: "sse", chunks: [{ content: "ok", finishReason: "stop" }] }));
    const state = new RecoveryState();
    const messages = plain();
    const result = await sendMessagesWithRecovery({
      requestMessages: messages,
      messages,
      state,
      maxTokens: 8000,
    });
    expect(result.action).toBe("success");
    if (result.action === "success") {
      expect(result.message.content).toBe("ok");
    }
  });

  it("finish_reason=length 首次升级 max_tokens 并 retry", async () => {
    mock.always(() => ({ kind: "sse", chunks: [{ content: "part", finishReason: "length" }] }));
    const state = new RecoveryState();
    const messages = plain();
    const result = await sendMessagesWithRecovery({
      requestMessages: messages,
      messages,
      state,
      maxTokens: 8000,
    });
    expect(result.action).toBe("retry");
    if (result.action === "retry") {
      expect(result.maxTokens).toBe(ESCALATED_MAX_TOKENS);
    }
    expect(state.hasEscalated).toBe(true);
  });

  it("升级后仍 length：追加续写提示，最多 MAX_RECOVERY_RETRIES 次", async () => {
    mock.always(() => ({ kind: "sse", chunks: [{ content: "part", finishReason: "length" }] }));
    const state = new RecoveryState();
    state.hasEscalated = true;
    const messages = plain();
    for (let i = 0; i < MAX_RECOVERY_RETRIES; i++) {
      const r = await sendMessagesWithRecovery({ requestMessages: messages, messages, state, maxTokens: 64000 });
      expect(r.action).toBe("retry");
      expect(messages[messages.length - 1].role).toBe("user");
      expect(String(messages[messages.length - 1].content)).toContain("Resume directly");
    }
    const last = await sendMessagesWithRecovery({ requestMessages: messages, messages, state, maxTokens: 64000 });
    expect(last.action).toBe("abort");
  });

  it("prompt_too_long 触发反应式压缩一次后重试", async () => {
    mock.push(() => ({
      kind: "error",
      status: 400,
      body: JSON.stringify({ error: { message: "prompt is too long" } }),
    }));
    mock.push(() => ({ kind: "sse", chunks: [{ content: "摘要", finishReason: "stop" }] })); // summarizeHistory
    mock.push(() => ({ kind: "sse", chunks: [{ content: "ok", finishReason: "stop" }] }));
    const state = new RecoveryState();
    const messages = plain();
    const first = await sendMessagesWithRecovery({ requestMessages: messages, messages, state, maxTokens: 8000 });
    expect(first.action).toBe("retry");
    expect(state.hasAttemptedReactiveCompact).toBe(true);
    const second = await sendMessagesWithRecovery({ requestMessages: messages, messages, state, maxTokens: 8000 });
    expect(second.action).toBe("success");
  });

  it("压缩后仍过长则 abort 并写 [Error] 消息", async () => {
    mock.always(() => ({
      kind: "error",
      status: 400,
      body: JSON.stringify({ error: { message: "prompt is too long" } }),
    }));
    const state = new RecoveryState();
    state.hasAttemptedReactiveCompact = true;
    const messages = plain();
    const result = await sendMessagesWithRecovery({ requestMessages: messages, messages, state, maxTokens: 8000 });
    expect(result.action).toBe("abort");
    expect(String(messages[messages.length - 1].content)).toContain("[Error]");
  });
});

describe("produce 抛出非传输错误（S3 兜底）", () => {
  it("模型未配置时 abort 并写 [Error]（不崩溃 loop）", async () => {
    setRetryPolicyForTest({ enabled: true, maxRetries: 0, baseDelayMs: 1 });
    // 移除 override → resolveCurrentModel 走真实路径会抛错；这里直接模拟抛错
    const state = new RecoveryState();
    const messages = plain();
    // 用未知模型 spec 触发 resolveSendModel 抛错
    const result = await sendMessagesWithRecovery({
      requestMessages: messages,
      messages,
      state,
      maxTokens: 8000,
      model: "ghost/none",
    });
    expect(result.action).toBe("abort");
    expect(String(messages[messages.length - 1].content)).toContain("[Error]");
  });

  it("用户中断（signal.aborted，ADR-0008）：abort 不写 [Error]、reason=interrupted", async () => {
    setRetryPolicyForTest({ enabled: true, maxRetries: 0, baseDelayMs: 1 });
    const state = new RecoveryState();
    const messages = plain();
    const controller = new AbortController();
    controller.abort();
    const result = await sendMessagesWithRecovery({
      requestMessages: messages,
      messages,
      state,
      maxTokens: 8000,
      model: "ghost/none",
      signal: controller.signal,
    });
    expect(result.action).toBe("abort");
    if (result.action === "abort") {
      expect(result.reason).toBe("interrupted");
    }
    // 不落脏数据：无 [Error] 消息追加
    expect(messages.some((m) => String(m.content ?? "").includes("[Error]"))).toBe(false);
  });
});
