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
import { sendMessages, type ChatMessage } from "./client.ts";
import { triggerHooks } from "./hook.ts";
import { LoopOptions } from "./loop-options.ts";

export interface AgentLoopOptions {
  maxTurn?: number;
  maxTokens?: number;
  isSubagent?: boolean;
  loopOptions?: LoopOptions;
}

export async function agentLoop(
  messages: ChatMessage[],
  options: AgentLoopOptions = {},
): Promise<string | null> {
  const { maxTurn = 100, maxTokens = 8000, isSubagent = false, loopOptions } = options;
  const opts = loopOptions ?? LoopOptions.fromLegacyIsSubagent(isSubagent);

  for (let turn = 0; turn < maxTurn; turn++) {
    // memory 注入（05）、teammate/通知注入（10）、压缩（04）在此接入
    const llmResult = await sendMessages(messages, {
      maxTokens,
      isSubagent: opts.exitOnFinalContent && !opts.preserveSystem,
      preserveSystem: opts.preserveSystem,
      quietOutput: opts.quietOutput,
    });
    const message = llmResult;

    if (message.toolCalls) {
      messages.push(message.modelDump() as unknown as ChatMessage);
      for (const toolCall of message.toolCalls) {
        let args: unknown;
        let parseError = "";
        try {
          args = JSON.parse(toolCall.function.arguments);
        } catch (e) {
          args = null;
          parseError = String(e);
        }
        let toolResult: string;
        if (args === null) {
          toolResult = JSON.stringify({
            status: "error",
            message: `Invalid arguments JSON: ${parseError}`,
          });
        } else if (typeof args !== "object" || Array.isArray(args)) {
          toolResult = JSON.stringify({
            status: "error",
            message: "Arguments must be a JSON object",
          });
        } else {
          // 02b：替换为 PreToolUse → execute → PostToolUse 管线
          toolResult = JSON.stringify({
            status: "error",
            message: `Unknown tool: ${toolCall.function.name}`,
          });
        }
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
      }
      continue;
    }

    if (message.content !== null) {
      messages.push(message.modelDump() as unknown as ChatMessage);
      if (opts.exitOnFinalContent) {
        return message.content;
      }
    }
    if (opts.exitOnFinalContent) {
      return "Subagent stopped after 30 turns without final answer.";
    }

    // 自然结束 → Stop hook（memory 提取归 05）
    const force = triggerHooks("Stop", messages, undefined, opts.skipMemoryStopHook);
    if (force) {
      messages.push({ role: "user", content: String(force) });
      continue;
    }
    return null;
  }
  return null;
}
