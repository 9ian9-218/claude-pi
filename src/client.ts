/**
 * client.ts — OpenAI 流式客户端（对齐 src/client.py）
 *
 * 消息保持裸 OpenAI JSON 结构（ADR-0005）：messages 数组直接传给 SDK，
 * assistant 消息经 modelDump() 转回裸结构。tools 参数在 02b 接入工具
 * 注册表后传入，02a 不发送 tools（模型不会返回 tool_calls）。
 */
import os from "node:os";
import OpenAI from "openai";
import { getSystemPrompt, updateContext } from "./prompt.ts";

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content?: string | null;
  tool_calls?: unknown[];
  tool_call_id?: string;
}

export interface ToolCallData {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface AssistantMessage {
  content: string | null;
  toolCalls: ToolCallData[] | null;
  needsFollowUp: boolean;
  finishReason: string | null;
  /** 裸 OpenAI 消息结构（对齐 Python model_dump(exclude_none=True)） */
  modelDump(): Record<string, unknown>;
}

export interface SendOptions {
  maxTokens?: number;
  isSubagent?: boolean;
  model?: string;
  preserveSystem?: boolean;
  quietOutput?: boolean;
  tools?: unknown[];
  /** 流式内容回调（TUI 渲染路径；quietOutput 时也触发） */
  onStream?: (text: string) => void;
}

let _client: OpenAI | null = null;

/** 懒创建客户端（读取 .env 注入的 base_url/api_key） */
export function getClient(): OpenAI {
  if (_client === null) {
    _client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL,
    });
  }
  return _client;
}

/** 测试隔离：重置缓存客户端 */
export function resetClient(): void {
  _client = null;
}

export function createAssistantMessage(
  content: string | null,
  toolCalls: ToolCallData[] | null,
  needsFollowUp: boolean,
  finishReason: string | null,
): AssistantMessage {
  return {
    content,
    toolCalls,
    needsFollowUp,
    finishReason,
    modelDump() {
      const d: Record<string, unknown> = { role: "assistant", content: this.content };
      if (this.toolCalls) {
        d.tool_calls = this.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.function.name, arguments: tc.function.arguments },
        }));
      }
      const cleaned: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(d)) {
        if (v !== null && v !== undefined) cleaned[k] = v;
      }
      return cleaned;
    },
  };
}

function ensureSystem(messages: ChatMessage[], content: string): void {
  if (messages.length > 0 && messages[0].role === "system") {
    messages[0].content = content;
    return;
  }
  messages.unshift({ role: "system", content });
}

export async function sendMessages(
  messages: ChatMessage[],
  options: SendOptions = {},
): Promise<AssistantMessage> {
  const {
    maxTokens = 8000,
    isSubagent = false,
    model,
    preserveSystem = false,
    quietOutput,
    tools,
    onStream,
  } = options;
  const quiet = quietOutput ?? isSubagent;

  if (!preserveSystem) {
    const context = updateContext({}, messages);
    const systemPrompt = getSystemPrompt(context, { isSubagent });
    ensureSystem(messages, systemPrompt);
  }

  const stream = await getClient().chat.completions.create({
    model: model ?? process.env.OPENAI_MODEL ?? "gpt-4o",
    messages: messages as never,
    ...(tools ? { tools: tools as never, tool_choice: "auto" as const } : {}),
    stream: true,
    max_tokens: maxTokens,
  });

  let needsFollowUp = false;
  let finishReason: string | null = null;
  const contentParts: string[] = [];
  const toolCallsAcc = new Map<
    number,
    { id: string; function: { name: string; arguments: string } }
  >();

  if (!quiet) {
    process.stdout.write("Model >\t ");
  }

  for await (const chunk of stream) {
    const choice = chunk.choices[0];
    if (!choice) continue;
    if (choice.finish_reason) {
      finishReason = choice.finish_reason;
    }
    const delta = choice.delta;
    if (delta.content) {
      if (!quiet) process.stdout.write(delta.content);
      onStream?.(delta.content);
      contentParts.push(delta.content);
    }
    if (delta.tool_calls) {
      needsFollowUp = true;
      for (const tc of delta.tool_calls) {
        const idx = tc.index;
        let acc = toolCallsAcc.get(idx);
        if (!acc) {
          acc = { id: "", function: { name: "", arguments: "" } };
          toolCallsAcc.set(idx, acc);
        }
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.function.name += tc.function.name;
        if (tc.function?.arguments) acc.function.arguments += tc.function.arguments;
      }
    }
  }

  if (!quiet) {
    process.stdout.write("\n");
  }

  const toolCalls: ToolCallData[] | null =
    toolCallsAcc.size === 0
      ? null
      : [...toolCallsAcc.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, acc]) => ({
            id: acc.id,
            type: "function",
            function: { name: acc.function.name, arguments: acc.function.arguments },
          }));

  const content = contentParts.join("") || null;
  return createAssistantMessage(content, toolCalls, needsFollowUp, finishReason);
}
