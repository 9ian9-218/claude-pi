/**
 * client.ts — LLM 传输层（pi-ai，ADR-0007）
 *
 * 对外接口不变：裸 OpenAI JSON 消息进（ChatMessage[]），AssistantMessage 出
 * （modelDump() 还原裸结构；裸 OpenAI 消息结构见 ADR-0010 §2 保留的技术选择）。
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
  type OpenAICompletionsCompat,
  type Tool as PiTool,
  type Usage,
} from "@earendil-works/pi-ai";
import { getSystemPrompt, updateContext } from "./prompt.ts";
import { getAgentContext, type AgentRole } from "./teammates/context.ts";
import { parseModelSpec, resolveCurrentModel, resetAiRuntime } from "./ai-runtime.ts";
import { resetSettingsCache } from "./settings.ts";
import type { UiEventSink } from "./ui-events.ts";
import { currentBudget } from "./task-budget.ts";
import { requestDeadline, RequestTimeout } from "./request-deadline.ts";

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content?: string | null;
  tool_calls?: unknown[];
  tool_call_id?: string;
  /** 响应计费信息（仅 assistant 真实响应落盘；回放/历史消息无此字段） */
  usage?: Usage;
  /** 运行时补记：本条消息的产生耗时 ms（assistant=模型请求；tool=工具执行） */
  durationMs?: number;
  /** 运行时补记：工具调用失败标记（仅 role=tool 消息） */
  toolError?: boolean;
  toolStatus?: import("./results.ts").ExecutionStatus;
  execution?: Pick<import("./results.ts").ToolResult, "exitCode" | "signal" | "durationMs" | "truncated" | "artifactRefs">;
  partial?: boolean;
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
  /** 本次响应的 token/成本（捕获时算；footer 统计用） */
  usage?: Usage;
}

export interface SendOptions {
  maxTokens?: number;
  isSubagent?: boolean;
  role?: AgentRole;
  /** "provider/id"；缺省用当前模型（resolveCurrentModel） */
  model?: string;
  preserveSystem?: boolean;
  quietOutput?: boolean;
  tools?: unknown[];
  /** UI 事件通道（架构 C）：stream 增量广播（text/thinking；quietOutput 时也触发） */
  uiEvents?: UiEventSink;
  /** 用户中断信号（Esc）；中断时流以 stopReason="aborted" 结束 */
  signal?: AbortSignal;
  /** 思考强度（P4 接入；off 不发 thinking 参数） */
  thinkingLevel?: ModelThinkingLevel;
  /**
   * 会话标识：透传给 pi-ai 作为 sessionId，供 provider 侧缓存路由
   * （prompt_cache_key / session-affinity 头）。同一会话内必须稳定，
   * 否则 provider 无法把后续请求路由到同一缓存副本（见 cache-stats.ts）。
   */
  sessionId?: string;
  /**
   * 系统提示身份覆盖：fork 子 agent 用它复用父会话的 system prompt
   * （与父请求同前缀才能命中 prompt cache）；不影响 quietOutput/重试语义。
   */
  promptIdentity?: { role: AgentRole; isSubagent: boolean };
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

/** Conservative byte-token reservation includes system text, tools and output. */
function reserveModelRequest(model: Model<Api>, context: Context, outputTokens: number) {
  const inputTokens = Buffer.byteLength(JSON.stringify(context), "utf8") + 256;
  const costs = model.cost;
  const priceKnown = costs.input > 0 || costs.output > 0;
  const cost = priceKnown ? (inputTokens * Math.max(costs.input, costs.cacheRead, costs.cacheWrite) + outputTokens * costs.output) / 1_000_000 : null;
  return currentBudget()?.reserveRequest(inputTokens + outputTokens, cost) ?? (() => {});
}

/** 测试隔离：注入自定义 Models 集合（mock/对拍通道） */
export function setClientModels(models: Models | null): void {
  _modelsOverride = models;
}

async function getModels(): Promise<Models> {
  if (_modelsOverride !== null) return _modelsOverride;
  return getModelRuntimeInstance();
}

/**
 * 会话亲和：opencode zen 网关按会话把请求路由到固定后端副本，缺会话头时
 * 直接拒绝（400 MissingSessionID），且无法复用该副本的缓存前缀。
 * 其可接受的头是 `x-session-id`，对应 pi-ai 的 sessionAffinityFormat="openrouter"；
 * 内置模型目录未为这些模型开启该开关，故在此按 baseUrl 补齐。
 */
function withSessionRouting(model: Model<Api>, sessionId: string | undefined): Model<Api> {
  if (!sessionId || model.api !== "openai-completions") return model;
  if (!model.baseUrl?.includes("opencode.ai")) return model;
  const compat = { ...(model.compat ?? {}) } as OpenAICompletionsCompat;
  if (compat.sendSessionAffinityHeaders === true) return model;
  return {
    ...model,
    compat: {
      ...compat,
      sendSessionAffinityHeaders: true,
      sessionAffinityFormat: "openrouter",
    },
  };
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
  extra?: { stopReason?: string; errorMessage?: string; usage?: Usage },
): AssistantMessage {
  return {
    content,
    toolCalls,
    needsFollowUp,
    finishReason,
    stopReason: extra?.stopReason ?? finishReason ?? "stop",
    ...(extra?.errorMessage ? { errorMessage: extra.errorMessage } : {}),
    ...(extra?.usage && extra.usage.totalTokens > 0 ? { usage: extra.usage } : {}),
    modelDump() {
      const d: Record<string, unknown> = { role: "assistant", content: this.content };
      if (this.toolCalls) {
        d.tool_calls = this.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.function.name, arguments: tc.function.arguments },
        }));
      }
      if (this.usage) d.usage = this.usage;
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
    { stopReason: stop, errorMessage: m.errorMessage, usage: m.usage },
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
    uiEvents,
    signal,
    thinkingLevel,
    sessionId,
  } = options;
  const quiet = quietOutput ?? isSubagent;

  if (!preserveSystem) {
    const context = updateContext({}, messages);
    const promptRole = options.promptIdentity?.role ?? options.role ?? getAgentContext().role;
    const promptIsSubagent = options.promptIdentity?.isSubagent ?? isSubagent;
    const systemPrompt = getSystemPrompt(context, {
      isSubagent: promptIsSubagent,
      role: promptRole,
    });
    ensureSystem(messages, systemPrompt);
  }

  const models = await getModels();
  const model = await resolveSendModel(modelSpec);
  const piTools = tools ? toPiTools(tools) : undefined;
  const context = toPiContext(messages, piTools);

  const budget = currentBudget();
  const combinedSignal = budget ? (signal ? AbortSignal.any([signal, budget.controller.signal]) : budget.controller.signal) : signal;
  const settle = reserveModelRequest(model, context, maxTokens);
  const deadline = requestDeadline(combinedSignal);
  let partialText = "";
  try {
    const stream = models.stream(withSessionRouting(model, sessionId), context, {
      maxTokens,
      ...(piTools ? { toolChoice: "auto" as const } : {}),
      ...(thinkingLevel && thinkingLevel !== "off" ? { reasoningEffort: thinkingLevel } : {}),
      signal: deadline.signal,
      ...(sessionId ? { sessionId } : {}),
    });
    if (!quiet) process.stdout.write("Model >\t ");
    const iterator = stream[Symbol.asyncIterator]();
    while (true) {
      const next = await deadline.wait(iterator.next());
      if (next.done) break;
      const event = next.value;
      if (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta") deadline.activity();
      if (event.type === "text_delta") {
        partialText = (partialText + event.delta).slice(0, 16_384);
        if (!quiet) process.stdout.write(event.delta);
        uiEvents?.emit("stream", { kind: "text", delta: event.delta });
      } else if (event.type === "thinking_delta") uiEvents?.emit("stream", { kind: "thinking", delta: event.delta });
    }
    const final = await deadline.wait(stream.result());
    settle(final.usage.totalTokens > 0 ? final.usage : undefined);
    if (deadline.signal.aborted) throw deadline.signal.reason;
    if (!quiet) process.stdout.write("\n");
    return fromPiMessage(final);
  } catch (e) {
    if (e instanceof RequestTimeout && partialText) e.partialText = partialText;
    throw e;
  } finally { settle(); deadline.dispose(); }
}

/**
 * 单轮文本补全（memory 提取 / compact 摘要用；无工具、无系统提示）。
 * 传输错误以 Error 抛出（调用方各自兜底）。
 */
export async function completeText(
  prompt: string,
  options: { maxTokens?: number; signal?: AbortSignal } = {},
): Promise<string> {
  return (await completeTextWithUsage(prompt, options)).text;
}

/** 同 completeText，但返回本次响应的计费信息（compaction 累计用） */
export async function completeTextWithUsage(
  prompt: string,
  options: { maxTokens?: number; signal?: AbortSignal } = {},
): Promise<{ text: string; usage?: Usage }> {
  options.signal?.throwIfAborted();
  const models = await getModels();
  const model = await resolveEffectiveModel();
  const context: Context = { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] };
  const maxTokens = options.maxTokens ?? 200;
  const settle = reserveModelRequest(model, context, maxTokens);
  const budgetSignal = currentBudget()?.controller.signal;
  const signal = options.signal && budgetSignal ? AbortSignal.any([options.signal, budgetSignal]) : options.signal ?? budgetSignal;
  const deadline = requestDeadline(signal);
  try {
    const m = await deadline.wait(models.completeSimple(model, context, { maxTokens, signal: deadline.signal }));
    settle(m.usage.totalTokens > 0 ? m.usage : undefined);
    if (m.stopReason === "error" || m.stopReason === "aborted") throw new Error(m.errorMessage ?? `LLM request failed (${m.stopReason})`);
    return {
      text: m.content.filter((b): b is { type: "text"; text: string } => b.type === "text").map(b => b.text).join("") || "",
      ...(m.usage && m.usage.totalTokens > 0 ? { usage: m.usage } : {}),
    };
  } finally { settle(); deadline.dispose(); }
}

/** 测试隔离：清除全部缓存（client 覆盖 / ModelRuntime / 设置 / 当前模型） */
export function resetClient(): void {
  _modelsOverride = null;
  resetAiRuntime();
  resetSettingsCache();
}
