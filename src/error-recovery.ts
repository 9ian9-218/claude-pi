/**
 * error-recovery.ts — LLM 调用错误恢复（对齐 src/error_recovery.py）
 *
 * Path 1: finish_reason=length → 8K→64K 升级 / 续写提示（≤3 次）
 * Path 2: prompt_too_long → reactive compact（一次）
 * Path 3: 429/529 → 指数退避 + 连续 529 切 fallback 模型
 */
import { sendMessages, resetClient, type AssistantMessage, type ChatMessage } from "./client.ts";
import { reactiveCompact } from "./compact.ts";
import { CONTINUATION_PROMPT } from "./prompt.ts";

export const ESCALATED_MAX_TOKENS = 64_000;
export const DEFAULT_MAX_TOKENS = 8_000;
export const MAX_RECOVERY_RETRIES = 3;
export const MAX_RETRIES = 10;
export const BASE_DELAY_MS = 500;
export const MAX_CONSECUTIVE_529 = 3;

export class RecoveryState {
  hasEscalated = false;
  recoveryCount = 0;
  consecutive529 = 0;
  hasAttemptedReactiveCompact = false;
  currentModel = process.env.OPENAI_MODEL ?? null;

  constructor() {
    // 与 Python 一致：启动时读取 OPENAI_MODEL
    this.currentModel = process.env.OPENAI_MODEL ?? null;
  }
}

export function retryDelay(attempt: number, retryAfter?: number): number {
  if (retryAfter !== undefined && retryAfter > 0) return retryAfter;
  const base = Math.min(BASE_DELAY_MS * 2 ** attempt, 32_000) / 1000;
  const jitter = Math.random() * base * 0.25;
  return base + jitter;
}

function extractRetryAfter(e: unknown): number | undefined {
  const headers = (e as { headers?: Record<string, string | undefined> })?.headers;
  const raw = headers?.["retry-after"] ?? headers?.["Retry-After"];
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export async function withRetry<T>(fn: () => Promise<T>, state: RecoveryState): Promise<T> {
  const fallbackModel = process.env.FALLBACK_MODEL_ID;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const result = await fn();
      state.consecutive529 = 0;
      return result;
    } catch (e) {
      const err = e as Error & { status?: number };
      const name = err.name ?? "Error";
      const msg = String(err.message ?? "").toLowerCase();
      const retryAfter = extractRetryAfter(e);

      // 429 rate limit → 指数退避
      if (name.toLowerCase().includes("ratelimit") || msg.includes("429") || err.status === 429) {
        const delay = retryDelay(attempt, retryAfter);
        console.log(
          `  \x1b[33m[429 rate limit] retry ${attempt + 1}/${MAX_RETRIES}, wait ${delay.toFixed(1)}s\x1b[0m`,
        );
        await sleep(delay);
        continue;
      }

      // 529 overloaded → 退避 + fallback
      if (msg.includes("overloaded") || msg.includes("529") || err.status === 529) {
        state.consecutive529 += 1;
        if (state.consecutive529 >= MAX_CONSECUTIVE_529) {
          if (fallbackModel) {
            state.currentModel = fallbackModel;
            state.consecutive529 = 0;
            console.log(
              `  \x1b[31m[529 x${MAX_CONSECUTIVE_529}] switching to ${fallbackModel}\x1b[0m`,
            );
          } else {
            state.consecutive529 = 0;
            console.log(
              `  \x1b[31m[529 x${MAX_CONSECUTIVE_529}] no FALLBACK_MODEL_ID configured, continuing retry\x1b[0m`,
            );
          }
        }
        const delay = retryDelay(attempt, retryAfter);
        console.log(
          `  \x1b[33m[529 overloaded] retry ${attempt + 1}/${MAX_RETRIES}, wait ${delay.toFixed(1)}s\x1b[0m`,
        );
        await sleep(delay);
        continue;
      }

      // 非暂时性错误 → 抛出
      throw e;
    }
  }
  throw new Error(`Max retries (${MAX_RETRIES}) exceeded`);
}

function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

export function isPromptTooLongError(e: unknown): boolean {
  const msg = String((e as Error).message ?? "").toLowerCase();
  return (
    (msg.includes("prompt") && msg.includes("long")) ||
    msg.includes("prompt_is_too_long") ||
    msg.includes("prompt_too_long") ||
    msg.includes("context_length_exceeded") ||
    msg.includes("max_context_window") ||
    msg.includes("too many tokens")
  );
}

function isMaxTokensFinish(finishReason: string | null): boolean {
  return finishReason === "length" || finishReason === "max_tokens";
}

function appendErrorMessage(messages: ChatMessage[], text: string): void {
  messages.push({ role: "assistant", content: `[Error] ${text}` });
}

export type LLMInvokeResult =
  | { action: "success"; message: AssistantMessage }
  | { action: "retry"; maxTokens?: number }
  | { action: "abort" };

export interface RecoveryOptions {
  requestMessages: ChatMessage[];
  messages: ChatMessage[];
  state: RecoveryState;
  maxTokens: number;
  isSubagent?: boolean;
  preserveSystem?: boolean;
  quietOutput?: boolean;
  tools?: unknown[];
  onStream?: (text: string) => void;
}

export async function sendMessagesWithRecovery(
  options: RecoveryOptions,
): Promise<LLMInvokeResult> {
  const {
    requestMessages,
    messages,
    state,
    maxTokens,
    isSubagent = false,
    preserveSystem = false,
    quietOutput,
    tools,
    onStream,
  } = options;

  let message: AssistantMessage;
  try {
    message = await withRetry(
      () =>
        sendMessages(requestMessages, {
          maxTokens,
          isSubagent,
          model: state.currentModel ?? undefined,
          preserveSystem,
          quietOutput,
          tools,
          onStream,
        }),
      state,
    );
  } catch (e) {
    // Path 2: prompt/context 太长
    if (isPromptTooLongError(e)) {
      if (!state.hasAttemptedReactiveCompact) {
        console.log("  \x1b[31m[reactive compact]\x1b[0m");
        messages.splice(0, messages.length, ...(await reactiveCompact(messages)));
        state.hasAttemptedReactiveCompact = true;
        return { action: "retry" };
      }
      console.log("  \x1b[31m[unrecoverable] still too long after compact\x1b[0m");
      appendErrorMessage(messages, "Context too large, cannot continue.");
      return { action: "abort" };
    }
    // 其它异常不可恢复
    const name = (e as Error).name ?? "Error";
    console.log(`  \x1b[31m[unrecoverable] ${name}: ${String((e as Error).message).slice(0, 100)}\x1b[0m`);
    appendErrorMessage(messages, `${name}: ${String((e as Error).message).slice(0, 200)}`);
    return { action: "abort" };
  }

  // Path 1: 输出截断
  if (isMaxTokensFinish(message.finishReason)) {
    if (!state.hasEscalated) {
      const newMax = ESCALATED_MAX_TOKENS;
      state.hasEscalated = true;
      console.log(`  \x1b[33m[max_tokens] escalating ${maxTokens} -> ${newMax}\x1b[0m`);
      return { action: "retry", maxTokens: newMax };
    }
    messages.push(message.modelDump() as unknown as ChatMessage);
    if (state.recoveryCount < MAX_RECOVERY_RETRIES) {
      messages.push({ role: "user", content: CONTINUATION_PROMPT });
      state.recoveryCount += 1;
      console.log(
        `  \x1b[33m[max_tokens] continuation ${state.recoveryCount}/${MAX_RECOVERY_RETRIES}\x1b[0m`,
      );
      return { action: "retry", maxTokens };
    }
    console.log("  \x1b[31m[max_tokens] recovery limit reached\x1b[0m");
    return { action: "abort" };
  }

  return { action: "success", message };
}

// 测试隔离辅助
export function resetRecoveryClient(): void {
  resetClient();
}
