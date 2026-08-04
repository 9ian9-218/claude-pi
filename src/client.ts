/**
 * client.ts — LLM 传输层（pi-ai，ADR-0007）
 *
 * 对外接口不变：裸 OpenAI JSON 消息进（ChatMessage[]），AssistantMessage 出
 * （modelDump() 还原裸结构，ADR-0005「裸 OpenAI 消息结构」条款保留）。
 * 内部经 pi-ai Models/stream 收发，provider 差异由 pi-ai 归一化。
 *
 * 配置面：模型/凭据来自 ModelRuntime（~/.pi/agent/，见 ai-runtime.ts）；
 * 测试用 setClientModels() 注入自定义 provider（chat-completions 线协议，
 * 对拍/mock 通道）。传输错误不抛出——以 stopReason="error" 的
 * AssistantMessage 返回，由 error-recovery 按 pi 的 retry 语义处理。
 */
import {
  type Api,
  type AssistantMessage as PiMessage,
  type Context,
  type Message as PiMessageUnion,
  type Model,
  type ModelThinkingLevel,
  type Models,
  type Tool as PiTool,
} from "@earendil-works/pi-ai";
import { getSystemPrompt, updateContext } from "./prompt.ts";
import { parseModelSpec, resolveCurrentModel, resetAiRuntime } from "./ai-runtime.ts";
import { resetSettingsCache } from "./settings.ts";

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
  /** pi-ai 语义：stop | length | toolUse | error | aborted（重试分类用） */
  stopReason: string;
  errorMessage?: string;
  /** 裸 OpenAI 消息结构（对齐 Python model_dump(exclude_none=True)） */
  modelDump(): Record<string, unknown>;
}

export interface SendOptions {
  maxTokens?: number;
  isSubagent?: boolean;
  /** "provider/id"；缺省用当前模型（resolveCurrentModel） */
  model?: string;
  preserveSystem?: boolean;
  quietOutput?: boolean;
  tools?: unknown[];
  /** 流式内容回调（TUI 渲染路径；quietOutput 时也触发） */
  onStream?: (text: string) => void;
  /** 思考强度（P4 接入；off 不发 thinking 参数） */
  thinkingLevel?: ModelThinkingLevel;
}

export const DEFAULT_MAX_TOKENS = 8_000;

/** 零 usage 占位（历史消息回放不需要真实计费） */
const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

let _modelsOverride: Models | null = null;

/** 测试隔离：注入自定义 Models 集合（mock/对拍通道） */
export function setClientModels(models: Models | null): void {
  _modelsOverride = models;
}

async function getModels(): Promise<Models> {
  if (_modelsOverride !== null) return _modelsOverride;
  return getModelRuntimeInstance();
}

// 延迟导入避免循环：ai-runtime 不依赖 client
async function getModelRuntimeInstance(): Promise<Models> {
  const { getModelRuntime } = await import("./ai-runtime.ts");
  return getModelRuntime();
}

async function resolveEffectiveModel(): Promise<Model<Api>> {
  // 测试 override 优先：unit 测试不触碰真实 ~/.pi/agent（ModelRuntime）
  if (_modelsOverride !== null) {
    const all = _modelsOverride.getModels();
    if (all.length === 0) throw new Error("No models registered");
    return all[0];
  }
  return resolveCurrentModel();
}

async function resolveSendModel(modelSpec?: string): Promise<Model<Api>> {
  if (!modelSpec) return resolveEffectiveModel();
  const { provider, id } = parseModelSpec(modelSpec);
  const models = await getModels();
  const found = provider
    ? models.getModel(provider, id)
    : models
        .getProviders()
        .map((p) => models.getModel(p.id, id))
        .find((m) => m !== undefined);
  if (!found) throw new Error(`Unknown model: ${modelSpec}`);
  return found;
}

export function createAssistantMessage(
  content: string | null,
  toolCalls: ToolCallData[] | null,
  needsFollowUp: boolean,
  finishReason: string | null,
  extra?: { stopReason?: string; errorMessage?: string },
): AssistantMessage {
  return {
    content,
    toolCalls,
    needsFollowUp,
    finishReason,
    stopReason: extra?.stopReason ?? finishReason ?? "stop",
    ...(extra?.errorMessage ? { errorMessage: extra.errorMessage } : {}),
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

// ── 裸 OpenAI JSON ↔ pi-ai Context 转换 ───────────────────────────────────

function safeParseArguments(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function toPiTools(tools: unknown[]): PiTool[] {
  return (tools as Array<{
    type: string;
    function: { name: string; description: string; parameters: Record<string, unknown> };
  }>).map((t) => ({
    name: t.function.name,
    description: t.function.description,
    // 裸 JSON Schema 与 TypeBox schema 同为 JSON Schema；pi-ai 原样透传
    parameters: t.function.parameters as unknown as PiTool["parameters"],
    // ADR-0007：OPENAI_TOOL_STRICT env 移除，strict 语义由 constrainedSampling 承接
    constrainedSampling: { type: "json_schema", strict: "prefer" as const },
  }));
}

function toPiContext(messages: ChatMessage[], tools?: PiTool[]): Context {
  const system = messages.find((m) => m.role === "system");
  const rest = messages.filter((m) => m.role !== "system");
  const piMessages: PiMessageUnion[] = rest.map((m): PiMessageUnion => {
    if (m.role === "user") {
      return { role: "user", content: m.content ?? "", timestamp: Date.now() };
    }
    if (m.role === "assistant") {
      const blocks: PiMessage["content"] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const tc of (m.tool_calls ?? []) as ToolCallData[]) {
        blocks.push({
          type: "toolCall",
          id: tc.id,
          name: tc.function.name,
          arguments: safeParseArguments(tc.function.arguments),
        });
      }
      return {
        role: "assistant",
        content: blocks,
        api: "openai-completions",
        provider: "openai",
        model: "",
        usage: ZERO_USAGE,
        stopReason: blocks.length > 0 ? "toolUse" : "stop",
        timestamp: Date.now(),
      };
    }
    return {
      role: "toolResult",
      toolCallId: m.tool_call_id ?? "",
      toolName: "",
      content: [{ type: "text", text: m.content ?? "" }],
      isError: false,
      timestamp: Date.now(),
    };
  });
  return {
    ...(system?.content ? { systemPrompt: system.content } : {}),
    messages: piMessages,
    ...(tools ? { tools } : {}),
  };
}

function fromPiMessage(m: PiMessage): AssistantMessage {
  const content =
    m.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("") || null;
  const toolCalls: ToolCallData[] | null = m.content
    .filter((b) => b.type === "toolCall")
    .map((b) => ({
      id: b.id,
      type: "function",
      function: { name: b.name, arguments: JSON.stringify(b.arguments) },
    }));
  const stop = m.stopReason;
  const finishReason =
    stop === "toolUse"
      ? "tool_calls"
      : stop === "stop"
        ? "stop"
        : stop === "length"
          ? "length"
          : stop === "pending"
            ? null
            : stop; // "error" | "aborted" 原样透传
  return createAssistantMessage(
    content,
    toolCalls.length > 0 ? toolCalls : null,
    toolCalls.length > 0,
    finishReason,
    { stopReason: stop, errorMessage: m.errorMessage },
  );
}

// ── 对外 API ─────────────────────────────────────────────────────────────

export async function sendMessages(
  messages: ChatMessage[],
  options: SendOptions = {},
): Promise<AssistantMessage> {
  const {
    maxTokens = DEFAULT_MAX_TOKENS,
    isSubagent = false,
    model: modelSpec,
    preserveSystem = false,
    quietOutput,
    tools,
    onStream,
    thinkingLevel,
  } = options;
  const quiet = quietOutput ?? isSubagent;

  if (!preserveSystem) {
    const context = updateContext({}, messages);
    const systemPrompt = getSystemPrompt(context, { isSubagent });
    ensureSystem(messages, systemPrompt);
  }

  const models = await getModels();
  const model = await resolveSendModel(modelSpec);
  const piTools = tools ? toPiTools(tools) : undefined;
  const context = toPiContext(messages, piTools);

  const stream = models.stream(model, context, {
    maxTokens,
    ...(piTools ? { toolChoice: "auto" as const } : {}),
    ...(thinkingLevel && thinkingLevel !== "off" ? { reasoningEffort: thinkingLevel } : {}),
  });

  if (!quiet) {
    process.stdout.write("Model >\t ");
  }

  for await (const event of stream) {
    if (event.type === "text_delta") {
      if (!quiet) process.stdout.write(event.delta);
      onStream?.(event.delta);
    }
  }

  const final = await stream.result();

  if (!quiet) {
    process.stdout.write("\n");
  }

  return fromPiMessage(final);
}

/**
 * 单轮文本补全（memory 提取 / compact 摘要用；无工具、无系统提示）。
 * 传输错误以 Error 抛出（调用方各自兜底）。
 */
export async function completeText(
  prompt: string,
  options: { maxTokens?: number } = {},
): Promise<string> {
  const models = await getModels();
  const model = await resolveEffectiveModel();
  const m = await models.completeSimple(
    model,
    { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
    { maxTokens: options.maxTokens ?? 200 },
  );
  if (m.stopReason === "error" || m.stopReason === "aborted") {
    throw new Error(m.errorMessage ?? `LLM request failed (${m.stopReason})`);
  }
  return (
    m.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("") || ""
  );
}

/** 测试隔离：清除全部缓存（client 覆盖 / ModelRuntime / 设置 / 当前模型） */
export function resetClient(): void {
  _modelsOverride = null;
  resetAiRuntime();
  resetSettingsCache();
}
