import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MockOpenAI } from "../tests/helpers/mock-openai.ts";
import { resetClient, type ChatMessage } from "./client.ts";
import {
  RecoveryState,
  retryDelay,
  withRetry,
  isPromptTooLongError,
  sendMessagesWithRecovery,
  ESCALATED_MAX_TOKENS,
  MAX_RECOVERY_RETRIES,
} from "./error-recovery.ts";

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
});

function plain(): ChatMessage[] {
  return [{ role: "user", content: "hi" }];
}

describe("retryDelay（S3）", () => {
  it("Retry-After 优先", () => {
    expect(retryDelay(0, 5)).toBe(5);
  });

  it("指数退避 + jitter 在 [base, base*1.25] 内", () => {
    const d0 = retryDelay(0);
    expect(d0).toBeGreaterThanOrEqual(0.5);
    expect(d0).toBeLessThanOrEqual(0.5 * 1.25);
    const d5 = retryDelay(5);
    expect(d5).toBeGreaterThanOrEqual(16);
    expect(d5).toBeLessThanOrEqual(16 * 1.25);
    const d10 = retryDelay(10);
    expect(d10).toBeLessThanOrEqual(32 * 1.25); // 上限 32s
  });
});

describe("withRetry（S3）", () => {
  it("429 指数退避后成功", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const fn = vi.fn(async () => {
        calls++;
        if (calls < 3) {
          const err = new Error("429 rate limit") as Error & { status?: number };
          throw err;
        }
        return "ok";
      });
      const state = new RecoveryState();
      const p = withRetry(fn, state);
      await vi.advanceTimersByTimeAsync(30_000);
      const result = await p;
      expect(result).toBe("ok");
      expect(calls).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("连续 3 次 529 切换 fallback 模型", async () => {
    vi.useFakeTimers();
    try {
      process.env.FALLBACK_MODEL_ID = "fallback-model";
      let calls = 0;
      const fn = vi.fn(async () => {
        calls++;
        if (calls <= 3) throw new Error("529 overloaded");
        return "ok";
      });
      const state = new RecoveryState();
      const p = withRetry(fn, state);
      await vi.advanceTimersByTimeAsync(60_000);
      await p;
      expect(state.currentModel).toBe("fallback-model");
    } finally {
      vi.useRealTimers();
    }
  });

  it("非暂时性错误直接抛出", async () => {
    const fn = vi.fn(async () => {
      throw new Error("some other error");
    });
    const state = new RecoveryState();
    await expect(withRetry(fn, state)).rejects.toThrow("some other error");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("isPromptTooLongError（S3）", () => {
  it("识别 prompt/context 过长错误", () => {
    expect(isPromptTooLongError(new Error("prompt is too long"))).toBe(true);
    expect(isPromptTooLongError(new Error("context_length_exceeded"))).toBe(true);
    expect(isPromptTooLongError(new Error("max_context_window exceeded"))).toBe(true);
    expect(isPromptTooLongError(new Error("rate limit"))).toBe(false);
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
    mock.push(() => ({ kind: "json", content: "摘要" })); // summarizeHistory 非流式
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
    mock.always(() => ({ kind: "error", status: 400, body: JSON.stringify({ error: { message: "prompt is too long" } }) }));
    const state = new RecoveryState();
    state.hasAttemptedReactiveCompact = true;
    const messages = plain();
    const result = await sendMessagesWithRecovery({ requestMessages: messages, messages, state, maxTokens: 8000 });
    expect(result.action).toBe("abort");
    expect(String(messages[messages.length - 1].content)).toContain("[Error]");
  });

  it("不可恢复异常 abort 并写 [Error] 消息", async () => {
    mock.always(() => ({ kind: "error", status: 500, body: JSON.stringify({ error: { message: "boom" } }) }));
    const state = new RecoveryState();
    const messages = plain();
    const result = await sendMessagesWithRecovery({ requestMessages: messages, messages, state, maxTokens: 8000 });
    expect(result.action).toBe("abort");
    expect(String(messages[messages.length - 1].content)).toContain("[Error]");
  });
});
