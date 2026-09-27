/**
 * agent-loop.ts — Agent 主循环（对齐 src/agent_loop.py）
 *
 * hook 挂载点：UserPromptSubmit（REPL 触发）→ send_messages → PreToolUse（02b）
 * → execute（02b）→ PostToolUse（02b）→ Stop
 *
 * 02a 范围：无工具注册表——模型不会收到 tools 参数；若 mock/异常返回
 * tool_calls，按未知工具产生错误结果（对齐 Python validate_hook 语义）。
 * compact（04）、memory（05）、background（06）、错误恢复（03）后续接入。
 */
import { randomUUID } from "node:crypto";
import { sendMessages } from "./client.ts";
import { triggerHooks } from "./hook.ts";
import { LoopOptions } from "./loop-options.ts";
import { executeToolCall, getOpenaiTools } from "./tool.ts";
import { RecoveryState, sendMessagesWithRecovery, ERROR_PREFIX } from "./error-recovery.ts";
import { snapshotMessages } from "./memory.ts";
import { primeMemorySnapshot } from "./memory-scope.ts";
import { RELEVANT_MEMORIES_OPEN, SUBAGENT_STOPPED_MESSAGE } from "./prompt.ts";
import { consumePendingNotifications } from "./message-queue.ts";
import { shouldRunBackground, startBackgroundTask } from "./background-task.ts";
import { getWorkdir, runWithWorkdir } from "./workdir.ts";
import { getAgentContext } from "./teammates/context.ts";
import { maybeCompact } from "./compact.ts";
import type { SessionManager } from "./session-manager.ts";
import type { ChatMessage } from "./client.ts";
import { consumePendingInjections, consumePendingIdleNotifications } from "./teammates/poller.ts";
import { detectCacheMiss, CACHE_TTL_MS } from "./cache-stats.ts";
import { UiEventSink, emitNoticeOrLog, type TurnEndEvent } from "./ui-events.ts";
import { processPendingLeadPermissions } from "./permission-sync.ts";
import { formatIdleNotificationInjection } from "./teammates/protocol.ts";

/** 耗时补记：把模型请求耗时挂到 assistant 裸消息上（S4 轨迹分析用，0ms 也记录） */
function attachDuration(msg: ChatMessage, startedAt: number): ChatMessage {
  return { ...msg, durationMs: Math.round(performance.now() - startedAt) };
}

export interface AgentLoopOptions {
  maxTurn?: number;
  maxTokens?: number;
  isSubagent?: boolean;
  loopOptions?: LoopOptions;
  /** 树形会话（工单 12）：消息同步落盘，L4 写 compaction entry */
  session?: SessionManager;
}

export async function agentLoop(
  messages: ChatMessage[],
  options: AgentLoopOptions = {},
): Promise<string | null> {
  // 为整个 loop 上下文建立 workdir（claim/complete 的 setWorktreeOverride 在此生效）
  return runWithWorkdir(getWorkdir(), () => agentLoopInner(messages, options));
}

/**
 * 无会话模式（--no-session / 脚本接口）的缓存路由键。
 * provider（如 opencode zen 网关）要求请求带稳定会话标识才肯路由并复用缓存前缀；
 * 无持久会话时退化为进程级临时 id —— 不落盘、不参与会话恢复，仅保证同进程内前缀稳定。
 */
let ephemeralRoutingId: string | null = null;
function resolveRoutingSessionId(
  opts: LoopOptions,
  session: SessionManager | null | undefined,
): string {
  return opts.routingSessionId ?? session?.sessionId ?? (ephemeralRoutingId ??= randomUUID());
}

async function agentLoopInner(
  messages: ChatMessage[],
  options: AgentLoopOptions = {},
): Promise<string | null> {
  const { maxTurn = 100, maxTokens = 8000, isSubagent = false, loopOptions, session } = options;
  const opts = loopOptions ?? LoopOptions.fromLegacyIsSubagent(isSubagent);
  const recoveryState = new RecoveryState();
  let effectiveMaxTokens = maxTokens;
  const preCompress = snapshotMessages(messages);
  // 记忆：会话级冻结快照（本会话内新写入的记忆只在下一个新会话生效）
  await primeMemorySnapshot(messages, resolveRoutingSessionId(opts, session));
  // 06：lead 消费全局通知；teammate 定向（10 接入 agent context）
  const bgRecipient = undefined;

  for (let turn = 0; turn < maxTurn; turn++) {
    // teammate/通知注入
    if (opts.injectLeadNotifications) {
      // 仅 Lead 消费队友权限队列；subagent 走同步冒泡（bubbleSubagentPermission），
      // teammate 无 UI 不消费（否则 subagent 会替 Lead 弹 askUser）
      if (opts.isLeadRole) {
        await processPendingLeadPermissions(getAgentContext().teamName ?? "");
      }
      for (const content of consumePendingInjections()) {
        const msg: ChatMessage = { role: "user", content };
        messages.push(msg);
        session?.appendMessage(msg);
        emitNoticeOrLog(opts.uiEvents, `  \x1b[33m[inject] teammate inbox message\x1b[0m`, "inject");
      }
      for (const parsed of consumePendingIdleNotifications()) {
        const msg: ChatMessage = { role: "user", content: formatIdleNotificationInjection(parsed) };
        messages.push(msg);
        session?.appendMessage(msg);
        emitNoticeOrLog(opts.uiEvents, `  \x1b[33m[inject] teammate idle notification\x1b[0m`, "inject");
      }
    }
    if (opts.injectBackgroundNotifications) {
      for (const notif of consumePendingNotifications({ recipient: bgRecipient })) {
        const msg: ChatMessage = { role: "user", content: notif };
        messages.push(msg);
        session?.appendMessage(msg);
        emitNoticeOrLog(opts.uiEvents, `  \x1b[32m[inject] task_notification\x1b[0m`, "inject");
      }
    }
    // L4：自动压缩（#7 加深：门控/会话 entry/失败语义内吞，公共面一个调用）
    await maybeCompact(messages, { session, sink: opts.uiEvents });
    // 不再改写 messages：记忆已在 system 段（冻结），消息前缀保持逐字节稳定
    const requestMessages = messages;

    // 本次 LLM 调用前的最新落盘点：中断回滚目标（ADR-0008：不落脏数据）
    const llmStartLeaf = session?.getLeafId() ?? null;
    const llmStartedAt = performance.now();
    const llmResult = await sendMessagesWithRecovery({
      requestMessages,
      messages,
      state: recoveryState,
      maxTokens: effectiveMaxTokens,
      isSubagent: opts.isSubagentRole,
      preserveSystem: opts.preserveSystem,
      quietOutput: opts.quietOutput,
      // fork 子 agent：工具面按父身份取，保持与父请求同前缀（cache 命中）
      tools: getOpenaiTools(opts.cachePrefix?.role ?? opts.role),
      uiEvents: opts.uiEvents,
      thinkingLevel: opts.thinkingLevel,
      signal: opts.signal,
      sessionId: resolveRoutingSessionId(opts, session),
      ...(opts.cachePrefix ? { promptIdentity: opts.cachePrefix } : {}),
    });
    if (llmResult.action === "retry") {
      if (llmResult.maxTokens !== undefined) {
        effectiveMaxTokens = llmResult.maxTokens;
      }
      continue;
    }
    if (llmResult.action === "abort") {
      if (session) {
        if (llmResult.reason === "interrupted") {
          // ADR-0008：用户中断不落脏数据——回滚本次未完成的落盘（无落盘时 no-op）
          session.truncateTo(llmStartLeaf);
        } else {
          // 不可恢复错误：把 error-recovery 追加的 [Error] 收尾消息落盘，
          // 断连恢复后用户能看到回合失败原因（而非无痕中断）
          const last = messages[messages.length - 1];
          if (
            last &&
            last.role === "assistant" &&
            typeof last.content === "string" &&
            last.content.startsWith(ERROR_PREFIX)
          ) {
            session.appendMessage(last);
          }
        }
      }
      // ADR-0008：中断（Esc）/不可恢复错误 → 回合结束事件（UI 显示中止态）
      opts.uiEvents?.emit("turnEnd", {
        stopReason: llmResult.reason === "interrupted" ? "aborted" : "error",
        errorMessage: llmResult.errorMessage,
      });
      return null;
    }
    const message = llmResult.message;
    // 缓存诊断（对齐 pi）：回合结束前扫描分支（未含本消息），检测应命中却重计费
    let cacheMiss: TurnEndEvent["cacheMiss"];
    if (session && message.usage) {
      const miss = detectCacheMiss(session.getBranch(), message.usage, Date.now());
      if (miss) {
        cacheMiss = {
          missedTokens: miss.missedTokens,
          missedCost: miss.missedCost,
          idleMs: miss.idleMs,
        };
      }
    }
    const turnUsage = message.usage;
    opts.uiEvents?.emit("turnEnd", {
      stopReason: message.stopReason,
      errorMessage: message.errorMessage,
      // 无 session 的 agent（teammate）靠这个字段累计用量
      ...(turnUsage
        ? {
            usage: {
              input: turnUsage.input,
              output: turnUsage.output,
              cacheRead: turnUsage.cacheRead,
              cacheWrite: turnUsage.cacheWrite,
              cost: turnUsage.cost?.total ?? 0,
            },
          }
        : {}),
      ...(cacheMiss ? { cacheMiss } : {}),
    });
    // REPL/console 模式（无 UI 事件通道）：直接提示
    if (cacheMiss && !opts.uiEvents) {
      const idleHint = cacheMiss.idleMs > CACHE_TTL_MS ? "; idle >5min" : "";
      console.log(
        `  \x1b[90m[cache miss] ${cacheMiss.missedTokens.toLocaleString()} tokens should have been cache reads${idleHint}\x1b[0m`,
      );
    }

    if (message.toolCalls) {
      const assistantMsg = attachDuration(message.modelDump() as unknown as ChatMessage, llmStartedAt);
      messages.push(assistantMsg);
      session?.appendMessage(assistantMsg);
      for (const toolCall of message.toolCalls) {
        // ADR-0008：中断后不再执行/落盘剩余工具——回滚本轮已落盘内容并结束回合
        if (opts.signal?.aborted) {
          session?.truncateTo(llmStartLeaf);
          opts.uiEvents?.emit("turnEnd", { stopReason: "aborted", errorMessage: undefined });
          return null;
        }
        const toolStartedAt = performance.now();
        let args: unknown;
        let parseError = "";
        try {
          args = JSON.parse(toolCall.function.arguments);
        } catch (e) {
          args = null;
          parseError = String(e);
        }
        // ADR-0008：无论参数是否合法都广播工具事件，UI 据此渲染执行块
        opts.uiEvents?.emit("tool", {
          phase: "start",
          name: toolCall.function.name,
          id: toolCall.id,
          args,
        });
        let toolResult: string;
        let toolError = false;
        if (args === null) {
          toolResult = JSON.stringify({
            status: "error",
            message: `Invalid arguments JSON: ${parseError}`,
          });
          toolError = true;
        } else if (typeof args !== "object" || Array.isArray(args)) {
          toolResult = JSON.stringify({
            status: "error",
            message: "Arguments must be a JSON object",
          });
          toolError = true;
        } else {
          const block = {
            name: toolCall.function.name,
            input: args as Record<string, unknown>,
            id: toolCall.id,
          };
          const blocked = await triggerHooks("PreToolUse", block);
          if (blocked !== null && blocked !== undefined) {
            toolResult = JSON.stringify({ status: "error", message: String(blocked) });
            toolError = true;
          } else if (opts.enableBackground && shouldRunBackground(toolCall.function.name, args as Record<string, unknown>)) {
            const bgId = startBackgroundTask(toolCall, args as Record<string, unknown>);
            const command = String((args as Record<string, unknown>)["command"] ?? "");
            toolResult =
              `[Background task ${bgId} started] ` +
              `Command: ${command}. ` +
              `Output will arrive as a <task_notification> user message ` +
              `when the task completes or stalls.`;
          } else {
            toolResult = await executeToolCall(toolCall, args as Record<string, unknown>, {
              session,
              ...(opts.uiEvents ? { uiEvents: opts.uiEvents } : {}),
            });
            await triggerHooks("PostToolUse", block, toolResult);
          }
        }
        opts.uiEvents?.emit("tool", {
          phase: "result",
          name: toolCall.function.name,
          id: toolCall.id,
          args,
          result: toolResult,
          isError: toolError,
        });
        if (!opts.quietOutput) {
          console.log(
            `Tool >\t ${toolCall.function.name}(${toolCall.function.arguments}) -> ${toolResult}`,
          );
        }
        const toolDurationMs = Math.round(performance.now() - toolStartedAt);
        const toolMsg: ChatMessage = {
          role: "tool",
          tool_call_id: toolCall.id,
          content: toolResult,
          durationMs: toolDurationMs,
          ...(toolError ? { toolError: true as const } : {}),
        };
        messages.push(toolMsg);
        session?.appendMessage(toolMsg);
      }
      continue;
    }

    if (message.content !== null) {
      const assistantMsg = attachDuration(message.modelDump() as unknown as ChatMessage, llmStartedAt);
      messages.push(assistantMsg);
      session?.appendMessage(assistantMsg);
      if (opts.exitOnFinalContent) {
        return message.content;
      }
    }
    if (opts.exitOnFinalContent) {
      return SUBAGENT_STOPPED_MESSAGE;
    }

    // 自然结束 → Stop hook（memory 提取）
    const force = await triggerHooks("Stop", messages, preCompress, opts.skipMemoryStopHook);
    if (force) {
      const msg: ChatMessage = { role: "user", content: String(force) };
      messages.push(msg);
      session?.appendMessage(msg);
      continue;
    }
    return null;
  }
  return null;
}

/** 记忆注入：在最新可注入 user 消息前插入记忆（对齐 _build_request_messages） */
