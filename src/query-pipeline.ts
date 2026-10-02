/**
 * query-pipeline.ts — 单条用户查询的 Turn 装配（SessionRunner 第一刀）
 *
 * 统一原本散布在 cli.ts 三处（runRepl / runTui.onQuery / runSingleTurn）的：
 * Hook 触发 → 落盘 user message → 构建上下文 → agentLoop 装配。
 *
 * 差异点经选项注入：UI 事件通道 / 中断信号 / 思考强度 / quiet / 是否触发 Hook
 * （-p/--mode json 对拍路径不触发 Hook，保持字节级行为）。
 */
import { triggerHooks } from "./hook.ts";
import { agentLoopDetailed } from "./agent-loop.ts";
import type { RunResult } from "./results.ts";
import { LoopOptions } from "./loop-options.ts";
import type { SessionManager } from "./session-manager.ts";
import type { UiEventSink } from "./ui-events.ts";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ChatMessage } from "./client.ts";

export interface QueryTurnOptions {
  /** 会话树；null/缺省 = 无落盘的内存 turn */
  session?: SessionManager | null;
  /** UI 事件通道（ADR-0008） */
  uiEvents?: UiEventSink;
  /** Esc 中断信号 */
  signal?: AbortSignal;
  /** 思考强度 */
  thinkingLevel?: ModelThinkingLevel;
  /** 抑制 Model >/Tool > 控制台噪音 */
  quietOutput?: boolean;
  /** 完全覆盖 loop 选项（身份档案/策略由调用方托管时） */
  loopOptions?: LoopOptions;
  /** 是否触发 UserPromptSubmit hook；对拍路径（print/json）传 false */
  runHooks?: boolean;
  /**
   * 调用方持有的消息数组（无会话的脚本模式）：agentLoop 原地追加，
   * 调用方据此取回 turns/final。session 存在时忽略。
   */
  outMessages?: ChatMessage[];
}

/**
 * 执行一条用户查询：Hook → 落盘 → 构建上下文 → Agent Loop。
 * 返回 agentLoop 结果（最终文本或 null）。
 */
export async function runQuery(
  query: string,
  opts: QueryTurnOptions = {},
): Promise<string | null> {
  return (await runQueryDetailed(query, opts)).final;
}

export async function runQueryDetailed(query: string, opts: QueryTurnOptions = {}): Promise<RunResult> {
  if (opts.runHooks !== false) {
    await triggerHooks("UserPromptSubmit", query);
    void triggerHooks("user_prompt_submit", query);
  }

  let messages: ChatMessage[];
  if (opts.session) {
    opts.session.appendMessage({ role: "user", content: query });
    messages = opts.session.buildSessionContext().messages;
  } else if (opts.outMessages) {
    opts.outMessages.push({ role: "user", content: query });
    messages = opts.outMessages;
  } else {
    messages = [{ role: "user", content: query }];
  }

  const loopOptions =
    opts.loopOptions ??
    new LoopOptions({
      quietOutput: opts.quietOutput ?? false,
      uiEvents: opts.uiEvents,
      signal: opts.signal,
      thinkingLevel: opts.thinkingLevel,
      // 脚本模式（runHooks=false）不跑记忆 Stop 钩子：它是 fire-and-forget 的
      // 额外 LLM 调用，既不计入 usage，输出又会晚于 console 重定向还原漏进 stdout。
      ...(opts.runHooks === false ? { skipMemoryStopHook: true } : {}),
      ...(opts.runHooks === false ? { enableBackground: false } : {}),
    });

  return agentLoopDetailed(messages, {
    session: opts.session ?? undefined,
    loopOptions,
  });
}
