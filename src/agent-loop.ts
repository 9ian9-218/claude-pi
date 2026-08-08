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
import { sendMessages } from "./client.ts";
import { triggerHooks } from "./hook.ts";
import { LoopOptions } from "./loop-options.ts";
import { executeToolCall, getOpenaiTools } from "./tool.ts";
import { toolResultBudget, snipCompact, microCompact } from "./compact.ts";
import { RecoveryState, sendMessagesWithRecovery } from "./error-recovery.ts";
import { loadMemories, findMemoryInjectionIndex, snapshotMessages } from "./memory.ts";
import { RELEVANT_MEMORIES_OPEN } from "./prompt.ts";
import { consumePendingNotifications } from "./message-queue.ts";
import { shouldRunBackground, startBackgroundTask } from "./background-task.ts";
import { getWorkdir, runWithWorkdir } from "./workdir.ts";
import { getAgentContext } from "./teammates/context.ts";
import { CONTEXT_LIMIT, estimateMessagesTokens, compactHistory, summarizeHistory } from "./compact.ts";
import type { SessionManager } from "./session-manager.ts";
import type { ChatMessage } from "./client.ts";
import { consumePendingInjections, consumePendingIdleNotifications } from "./teammates/poller.ts";
import { processPendingLeadPermissions } from "./permission-sync.ts";
import { formatIdleNotificationInjection } from "./teammates/protocol.ts";

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

async function agentLoopInner(
  messages: ChatMessage[],
  options: AgentLoopOptions = {},
): Promise<string | null> {
  const { maxTurn = 100, maxTokens = 8000, isSubagent = false, loopOptions, session } = options;
  const opts = loopOptions ?? LoopOptions.fromLegacyIsSubagent(isSubagent);
  const recoveryState = new RecoveryState();
  let effectiveMaxTokens = maxTokens;
  const preCompress = snapshotMessages(messages);
  const memoriesContent = opts.enableMemory ? await loadMemories(messages) : "";
  // 06：lead 消费全局通知；teammate 定向（10 接入 agent context）
  const bgRecipient = undefined;

  for (let turn = 0; turn < maxTurn; turn++) {
    // teammate/通知注入
    if (opts.injectLeadNotifications) {
      await processPendingLeadPermissions(getAgentContext().teamName ?? "");
      for (const content of consumePendingInjections()) {
        const msg: ChatMessage = { role: "user", content };
        messages.push(msg);
        session?.appendMessage(msg);
        console.log(`  \x1b[33m[inject] teammate inbox message\x1b[0m`);
      }
      for (const parsed of consumePendingIdleNotifications()) {
        const msg: ChatMessage = { role: "user", content: formatIdleNotificationInjection(parsed) };
        messages.push(msg);
        session?.appendMessage(msg);
        console.log(`  \x1b[33m[inject] teammate idle notification\x1b[0m`);
      }
    }
    if (opts.injectBackgroundNotifications) {
      for (const notif of consumePendingNotifications({ recipient: bgRecipient })) {
        const msg: ChatMessage = { role: "user", content: notif };
        messages.push(msg);
        session?.appendMessage(msg);
        console.log(`  \x1b[32m[inject] task_notification\x1b[0m`);
      }
    }
    // L3/L1/L2 压缩（对齐 agent_loop.py：每轮发送前执行）
    replaceMessages(messages, toolResultBudget(messages));
    replaceMessages(messages, snipCompact(messages));
    replaceMessages(messages, microCompact(messages));
    // L4：会话模式写 compaction entry；非会话模式 Python 行为（LLM 摘要替换）
    if (estimateMessagesTokens(messages) > CONTEXT_LIMIT) {
      console.log("  \x1b[31m[auto compact]\x1b[0m");
      if (session) {
        const tokensBefore = estimateMessagesTokens(messages);
        const summary = await summarizeHistory(messages);
        // retainedTail：最近的合理大小消息（排除超限大消息）
        const tail = messages
          .slice(-5)
          .filter((m) => estimateMessagesTokens([m]) <= 8_000);
        session.appendCompaction(
          summary,
          tokensBefore,
          tail.length > 0 ? tail : undefined,
        );
        replaceMessages(messages, session.buildSessionContext().messages);
      } else {
        replaceMessages(messages, await compactHistory(messages));
      }
    }
    const requestMessages = buildRequestMessages(messages, memoriesContent);

    const llmResult = await sendMessagesWithRecovery({
      requestMessages,
      messages,
      state: recoveryState,
      maxTokens: effectiveMaxTokens,
      isSubagent: opts.exitOnFinalContent && !opts.preserveSystem,
      preserveSystem: opts.preserveSystem,
      quietOutput: opts.quietOutput,
      tools: getOpenaiTools(opts.exitOnFinalContent && !opts.preserveSystem),
      uiEvents: opts.uiEvents,
      signal: opts.signal,
    });
    if (llmResult.action === "retry") {
      if (llmResult.maxTokens !== undefined) {
        effectiveMaxTokens = llmResult.maxTokens;
      }
      continue;
    }
    if (llmResult.action === "abort") {
      // ADR-0008：中断（Esc）/不可恢复错误 → 回合结束事件（UI 显示中止态）
      opts.uiEvents?.emit("turnEnd", {
        stopReason: llmResult.reason === "interrupted" ? "aborted" : "error",
        errorMessage: llmResult.errorMessage,
      });
      return null;
    }
    const message = llmResult.message;
    opts.uiEvents?.emit("turnEnd", {
      stopReason: message.stopReason,
      errorMessage: message.errorMessage,
    });

    if (message.toolCalls) {
      const assistantMsg = message.modelDump() as unknown as ChatMessage;
      messages.push(assistantMsg);
      session?.appendMessage(assistantMsg);
      for (const toolCall of message.toolCalls) {
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
            toolResult = await executeToolCall(toolCall, args as Record<string, unknown>);
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
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: toolResult,
        });
        session?.appendMessage(messages[messages.length - 1]);
      }
      continue;
    }

    if (message.content !== null) {
      const assistantMsg = message.modelDump() as unknown as ChatMessage;
      messages.push(assistantMsg);
      session?.appendMessage(assistantMsg);
      if (opts.exitOnFinalContent) {
        return message.content;
      }
    }
    if (opts.exitOnFinalContent) {
      return "Subagent stopped after 30 turns without final answer.";
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
function buildRequestMessages(messages: ChatMessage[], memoriesContent: string): ChatMessage[] {
  if (!memoriesContent) return messages;
  const memoryTurn = findMemoryInjectionIndex(messages);
  if (memoryTurn === null) return messages;
  const original = messages[memoryTurn].content;
  if (typeof original === "string" && original.startsWith(RELEVANT_MEMORIES_OPEN)) {
    return messages;
  }
  const requestMessages = [...messages];
  requestMessages[memoryTurn] = {
    ...messages[memoryTurn],
    content: memoriesContent + "\n\n" + original,
  };
  return requestMessages;
}

/** 原地替换 messages 内容（对齐 Python messages[:] = ...） */
function replaceMessages(messages: ChatMessage[], next: ChatMessage[]): void {
  messages.splice(0, messages.length, ...next);
}
