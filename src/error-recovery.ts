/**
 * error-recovery.ts — LLM 调用错误恢复（pi 语义，ADR-0007）
 *
 * 传输错误重试：pi 的 retryAssistantCall + isRetryableAssistantError
 * （settings.json 的 retry 键：enabled/maxRetries/baseDelayMs，默认
 * 3 次、2s 指数退避）。fallback 模型机制已取消（pi 无此概念），
 * 异常应对 = 重试 + 手动 /model 切换。
 *
 * Path 1: finish_reason=length → 8K→64K 升级 / 续写提示（≤3 次）【Python 语义保留】
 * Path 2: context overflow → reactive compact（一次）【pi 的 isContextOverflow 分类】
 */
import type { AssistantMessage as PiAssistantMessage, RetryPolicy } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_TOKENS,
  sendMessages,
  type AssistantMessage,
  type ChatMessage,
} from "./client.ts";
import { reactiveCompact } from "./compact.ts";
import { CONTINUATION_PROMPT } from "./prompt.ts";
import { readPiSettings, setSettingsOverrideForTest } from "./settings.ts";

export { DEFAULT_MAX_TOKENS };

// pi-ai 重试原语懒加载缓存（模块图大，避免 CLI 启动即加载）
let _piRetry: { retryAssistantCall: unknown; isContextOverflow: unknown } | null = null;

async function getPiRetry(): Promise<{
  retryAssistantCall: (typeof import("@earendil-works/pi-ai"))["retryAssistantCall"];
  isContextOverflow: (typeof import("@earendil-works/pi-ai"))["isContextOverflow"];
}> {
  if (_piRetry === null) {
    const m = await import("@earendil-works/pi-ai");
    _piRetry = { retryAssistantCall: m.retryAssistantCall, isContextOverflow: m.isContextOverflow };
  }
  return _piRetry as {
    retryAssistantCall: (typeof import("@earendil-works/pi-ai"))["retryAssistantCall"];
    isContextOverflow: (typeof import("@earendil-works/pi-ai"))["isContextOverflow"];
  };
}

export const ESCALATED_MAX_TOKENS = 64_000;
export const MAX_RECOVERY_RETRIES = 3;

export class RecoveryState {
  hasEscalated = false;
  recoveryCount = 0;
  hasAttemptedReactiveCompact = false;
}

/** 当前重试策略：共享 settings.json 的 retry 键（pi 默认 enabled/maxRetries=3/baseDelayMs=2000） */
export function getRetryPolicy(): RetryPolicy {
  return readPiSettings().retry;
}

/** 测试隔离：注入重试策略（null 恢复读 settings） */
export function setRetryPolicyForTest(policy: RetryPolicy | null): void {
  setSettingsOverrideForTest(policy === null ? null : { retry: policy });
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
  /** "provider/id"；缺省用当前模型 */
  model?: string;
  isSubagent?: boolean;
  preserveSystem?: boolean;
  quietOutput?: boolean;
  tools?: unknown[];
  onStream?: (text: string) => void;
}

export async function sendMessagesWithRecovery(
  options: RecoveryOptions,
): Promise<LLMInvokeResult> {
  // 懒加载 pi-ai（启动阶段不引入大模块图；仅在首次 LLM 调用时）
  const { retryAssistantCall, isContextOverflow } = await getPiRetry();
  const {
    requestMessages,
    messages,
    state,
    maxTokens,
    model: modelSpec,
    isSubagent = false,
    preserveSystem = false,
    quietOutput,
    tools,
    onStream,
  } = options;

  const produce = () =>
    sendMessages(requestMessages, {
      maxTokens,
      model: modelSpec,
      isSubagent,
      preserveSystem,
      quietOutput,
      tools,
      onStream,
    });

  // 类型桥接：claude-pi 的 AssistantMessage 携带 stopReason/errorMessage，
  // 与 pi-ai 的 isRetryableAssistantError 分类所需字段结构兼容。
  // 注：produce 抛出的非传输错误（如模型未配置）不被 retryAssistantCall 吞掉，
  // 在此捕获并转成不可恢复 abort（对齐旧 withRetry 的兜底语义）。
  let message: AssistantMessage;
  try {
    message = (await retryAssistantCall(
      produce as unknown as () => Promise<PiAssistantMessage>,
      getRetryPolicy(),
      undefined,
      {
        onRetryScheduled: (attempt, maxAttempts, delayMs, errorMessage) => {
          console.log(
            `  \x1b[33m[retry ${attempt}/${maxAttempts}] ${String(errorMessage).slice(0, 80)}, wait ${(delayMs / 1000).toFixed(1)}s\x1b[0m`,
          );
        },
      },
    )) as unknown as AssistantMessage;
  } catch (e) {
    const errText = (e as Error).message ?? String(e);
    console.log(`  \x1b[31m[unrecoverable] ${errText.slice(0, 100)}\x1b[0m`);
    appendErrorMessage(messages, errText.slice(0, 200));
    return { action: "abort" };
  }

  // 传输错误（重试耗尽后仍失败）
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    const errText = message.errorMessage ?? `LLM request failed (${message.stopReason})`;

    // Path 2: context overflow → reactive compact（一次）
    if (isContextOverflow(message as unknown as PiAssistantMessage)) {
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

    console.log(`  \x1b[31m[unrecoverable] ${errText.slice(0, 100)}\x1b[0m`);
    appendErrorMessage(messages, errText.slice(0, 200));
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
