/**
 * compact.ts — 上下文压缩（CC 语义 + pi 式摘要）
 *
 * 阶段 0（04）：L1–L3 压缩 + reactive/compactHistory；
 * 缓存优化（grill 共识 v3）：L1/L2 移除（CC 无对应物）；L3 = 工具输出
 * 统一出口截断（>30K 字符 + 落盘引用）；L4 = window 驱动触发（kE 真实
 * usage + 0.92 系数）+ pi 式结构化摘要（previousSummary 更新式 + split turn）。
 * L4 与会话树 compaction entry 的联动归工单 12。
 *
 * 阈值不写死 token 绝对值：窗口取模型真实 contextWindow（读不到 → 256K），
 * 输出预留取模型 maxTokens ∩ 应用单次输出上限，其余预算按窗口比例派生
 * （见 COMPACTION_RATIOS）。换模型即自动跟随。
 */
import fs from "node:fs";
import { writeFileAtomic } from "./atomic-write.ts";
import path from "node:path";
import { createHash } from "node:crypto";
import { getWorkdir } from "./workdir.ts";
import { emitNoticeOrLog, type UiEventSink } from "./ui-events.ts";
import type { SessionManager } from "./session-manager.ts";
import { completeTextWithUsage, type ChatMessage } from "./client.ts";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import type { SessionEntry, CompactionEntry } from "./session-manager.ts";
import { getCurrentModel } from "./ai-runtime.ts";
import { readPiSettings, DEFAULT_COMPACTION } from "./settings.ts";
import {
  formatCompactedUserMessage,
  formatCompactSummary,
  formatTurnPrefixSummary,
} from "./prompt.ts";

// 工具输出体积策略（与窗口无关，属 L3 出口口径）
export const PERSIST_THRESHOLD_TOKENS = 2_000;
export const PREVIEW_TOKENS = 500;

/**
 * 单次输出上限（撞输出上限后升级到的天花板）= 压缩的输出预留基准。
 * 主消费者是 maxOutputReserve；error-recovery 的输出升级路径反向引用本常量。
 */
export const ESCALATED_MAX_TOKENS = 64_000;

/** 读不到模型 contextWindow 时的兜底上下文窗口 */
export const DEFAULT_CONTEXT_WINDOW = 256_000;

/**
 * 窗口派生比例 —— 触发线/输出预留/摘要预算都由当前模型窗口算出。
 * 例外：retainedTail 是**固定 20K**（见 retention 一节）——按比例保留会让
 * 1M 窗口留 100K 原文尾巴，反而吃掉压缩收益。
 */
export const COMPACTION_RATIOS = {
  /** 触发线：kE ≥ pct × (窗口 − 输出预留)，0.92 对齐 CC 1.0.40 实证（LA1） */
  autoCompactPct: 0.92,
  /** 模型未报 maxTokens 时的输出预留比例（0.16：200K 窗口即 32K；本项目自定，
   * CC/pi 均无对应实证——CC 是按模型名硬编码 8192/32000） */
  outputReserve: 0.16,
  /** 摘要输出预算 / 窗口（0.1：200K 窗口即 20K，对齐 CC PM2 实证） */
  summaryOutput: 0.1,
} as const;

/** 当前模型窗口（真实值优先；模型缺失/非法 → DEFAULT_CONTEXT_WINDOW） */
export function resolveContextWindow(model: Model<Api> | null = getCurrentModel()): number {
  const w = model?.contextWindow;
  return typeof w === "number" && Number.isFinite(w) && w > 0
    ? Math.floor(w)
    : DEFAULT_CONTEXT_WINDOW;
}

/**
 * maxOutput 预留：有效窗口 = contextWindow − 预留（本应用一次请求最多要模型
 * 输出多少 token）。优先级：
 *   env CLAUDE_CODE_MAX_OUTPUT_TOKENS → settings.compaction.reserveTokens
 *   → min(模型 maxTokens, 应用单次输出上限) → 窗口 × COMPACTION_RATIOS.outputReserve
 * 不再按模型名字符串猜（旧实现：含 "3-5"/"haiku" → 8192，否则 32000）。
 */
export function maxOutputReserve(
  model: Model<Api> | null = getCurrentModel(),
  window = resolveContextWindow(model),
): number {
  const env = process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
  const fromEnv = env ? Number.parseInt(env, 10) : Number.NaN;
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;

  const configured = readPiSettings().compaction?.reserveTokens;
  if (typeof configured === "number" && configured > 0) return configured;

  const mt = model?.maxTokens;
  if (typeof mt === "number" && Number.isFinite(mt) && mt > 0) {
    // 预留至多占窗口一半：maxTokens ≥ 窗口的病态模型若原样预留，
    // 触发线会塌成 1（(window − reserve) × 0.92 ≤ 0），变成每轮都压。
    return Math.max(1, Math.min(mt, ESCALATED_MAX_TOKENS, Math.floor(window / 2)));
  }
  return Math.max(1, Math.min(Math.round(window * COMPACTION_RATIOS.outputReserve), window));
}

/**
 * retainedTail 预算：**固定 20K**（对齐 pi keepRecentTokens 默认），不随窗口缩放。
 * settings.compaction.keepRecentTokens 可显式覆盖。
 */
export function retainedTailBudget(): number {
  const configured = readPiSettings().compaction?.keepRecentTokens;
  if (typeof configured === "number" && configured > 0) return configured;
  return DEFAULT_COMPACTION.keepRecentTokens;
}

/**
 * 摘要输出预算 = min(窗口 × 10%, 模型 maxTokens, 应用单次输出上限)。
 * 不做 maxTokens 收敛会给小输出模型发超出其上限的 max_tokens（400 风险）。
 */
export function summaryOutputBudget(
  model: Model<Api> | null = getCurrentModel(),
  window = resolveContextWindow(model),
): number {
  const byWindow = Math.round(window * COMPACTION_RATIOS.summaryOutput);
  const mt = model?.maxTokens;
  const capped =
    typeof mt === "number" && Number.isFinite(mt) && mt > 0
      ? Math.min(byWindow, mt)
      : byWindow;
  return Math.max(1, Math.min(capped, ESCALATED_MAX_TOKENS));
}

/** 摘要输入上限 = 窗口 − 摘要输出预算（保证摘要调用自身不溢出窗口） */
export function summarizeInputCap(
  model: Model<Api> | null = getCurrentModel(),
  window = resolveContextWindow(model),
): number {
  return Math.max(1, window - summaryOutputBudget(model, window));
}

/**
 * 自动压缩触发阈值（CC 式：kE ≥ pct × (window − maxOutput 预留)）。
 * window 缺省取当前模型 contextWindow（读不到 → 256K 兜底）；
 * pct 默认 0.92（CC LA1 实证），settings.compaction.autoCompactPct 可覆盖。
 */
export function getCompactionThreshold(
  window?: number,
  pct?: number,
  model?: Model<Api> | null,
): number {
  const resolvedModel = model === undefined ? getCurrentModel() : model;
  const win = window ?? resolveContextWindow(resolvedModel);
  const settings = readPiSettings().compaction;
  const rate = pct ?? settings?.autoCompactPct ?? DEFAULT_COMPACTION.autoCompactPct;
  const reserve = maxOutputReserve(resolvedModel, win);
  return Math.max(1, Math.round((win - reserve) * rate));
}

/** 自动压缩是否启用（settings.compaction.enabled，默认开，对齐 pi） */
export function isAutoCompactEnabled(): boolean {
  return readPiSettings().compaction?.enabled ?? DEFAULT_COMPACTION.enabled;
}

/**
 * kE 上下文估算（CC 1.0.40 实证）：分支/消息尾部最近一条带 usage 的
 * assistant 消息的 prompt tokens（input + cacheRead + cacheWrite）；
 * 无 → null（调用方兜底字符估算）。
 */
export function estimateContextTokensByUsage(messages: ChatMessage[]): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && m.usage) {
      const t = m.usage.input + m.usage.cacheRead + m.usage.cacheWrite;
      if (t > 0) return t + (m.usage.output ?? 0) + estimateMessagesTokens(messages.slice(i + 1));
    }
  }
  return null;
}

export interface CompactionCutPoint {
  firstKeptIndex: number;
  turnStartIndex: number;
  isSplitTurn: boolean;
}

/** 移植自 pi-coding-agent 0.83.0 core/compaction/compaction.js 的 findCutPoint（MIT）。
 * 裸消息版：只在 user/assistant 前切分，绝不留下孤立 tool。
 * 工具回合必须已经闭合；未完成的执行不能被摘要伪装成已完成。 */
export function findCompactionCutPoint(messages: ChatMessage[], budgetTokens: number): CompactionCutPoint {
  const cutPoints: number[] = [];
  const pending = new Set<string>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "system") continue;
    if (m.role === "tool") {
      if (!m.tool_call_id || !pending.delete(m.tool_call_id)) {
        throw new Error("Cannot compact an orphan tool result");
      }
      continue;
    }
    if (pending.size) throw new Error("Cannot compact an incomplete tool turn");
    cutPoints.push(i);
    if (m.role === "assistant") {
      for (const call of m.tool_calls ?? []) {
        const id = (call as { id?: string }).id;
        if (!id || pending.has(id)) throw new Error("Cannot compact invalid tool call IDs");
        pending.add(id);
      }
    }
  }
  if (pending.size) throw new Error("Cannot compact an incomplete tool turn");
  if (!cutPoints.length) return { firstKeptIndex: messages.length, turnStartIndex: -1, isSplitTurn: false };

  let firstKeptIndex = cutPoints[0];
  let running = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    running += estimateMessageTokens(messages[i]);
    if (running >= Math.max(1, budgetTokens)) {
      firstKeptIndex = cutPoints.find(index => index >= i) ?? cutPoints[0];
      break;
    }
  }
  let turnStartIndex = -1;
  if (messages[firstKeptIndex]?.role !== "user") {
    for (let i = firstKeptIndex; i >= 0; i--) {
      if (messages[i].role === "user") { turnStartIndex = i; break; }
    }
  }
  return { firstKeptIndex, turnStartIndex, isSplitTurn: turnStartIndex >= 0 };
}

/** 尾巴预算允许按安全边界略有偏差，不能拆开 assistant + tool results。 */
export function pickRetainedTail(messages: ChatMessage[], budgetTokens: number): ChatMessage[] {
  return messages.slice(findCompactionCutPoint(messages, budgetTokens).firstKeptIndex);
}

export interface CompactionPreparation extends CompactionCutPoint {
  messagesToSummarize: ChatMessage[];
  turnPrefixMessages: ChatMessage[];
  retainedTail: ChatMessage[];
}

/** 历史摘要与被切开的当前回合前缀不重叠，保留后缀不送入摘要请求。 */
export function prepareCompaction(messages: ChatMessage[], budgetTokens: number): CompactionPreparation {
  let cut = findCompactionCutPoint(messages, budgetTokens);
  // cpi 的 /compact 是强制压缩：短历史也处理，尽量保留最新用户回合。
  if (cut.firstKeptIndex === 0 && messages.length) {
    let firstKeptIndex = messages.findLastIndex((m, i) => i > 0 && m.role === "user");
    if (firstKeptIndex < 0) firstKeptIndex = messages.findIndex((m, i) => i > 0 && m.role === "assistant");
    if (firstKeptIndex < 0) firstKeptIndex = messages.length;
    const turnStartIndex = firstKeptIndex < messages.length && messages[firstKeptIndex].role === "assistant"
      ? messages.findLastIndex((m, i) => i < firstKeptIndex && m.role === "user") : -1;
    cut = { firstKeptIndex, turnStartIndex, isSplitTurn: turnStartIndex >= 0 };
  }
  const historyEnd = cut.isSplitTurn ? cut.turnStartIndex : cut.firstKeptIndex;
  return {
    ...cut,
    messagesToSummarize: messages.slice(0, historyEnd),
    turnPrefixMessages: cut.isSplitTurn ? messages.slice(cut.turnStartIndex, cut.firstKeptIndex) : [],
    retainedTail: messages.slice(cut.firstKeptIndex),
  };
}

function toolResultsDir(): string {
  return path.join(getWorkdir(), ".task_outputs", "tool-results");
}

function transcriptDir(): string {
  return path.join(getWorkdir(), ".transcripts");
}

// ── Token 估算 ────────────────────────────────────────────────────────────

export function estimateTokens(text: string): number {
  const s = String(text);
  const chineseChars = (s.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const englishAlnum = (s.match(/[A-Za-z0-9]/g) ?? []).length;
  const otherChars = s.length - chineseChars - englishAlnum;
  const tokens = chineseChars * 0.6 + englishAlnum * 0.28 + otherChars * 0.2;
  return Math.max(1, Math.trunc(tokens) + 1);
}

export function estimateMessageTokens(msg: unknown): number {
  return estimateTokens(JSON.stringify(msg));
}

export function estimateMessagesTokens(messages: unknown[]): number {
  let sum = 0;
  for (const msg of messages) sum += estimateMessageTokens(msg);
  return sum;
}

// ── 工具输出处理（CC 式截断 + 落盘引用） ─────────────────────────
export function truncateToTokens(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi + 1) / 2);
    if (estimateTokens(text.slice(0, mid)) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  const suffix = lo < text.length ? "..." : "";
  return text.slice(0, lo) + suffix;
}

export function persistLargeOutput(toolCallId: string, output: string): string {
  if (estimateTokens(output) <= PERSIST_THRESHOLD_TOKENS) return output;
  const dir = toolResultsDir();
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${toolCallId}.txt`);
  if (!fs.existsSync(p)) {
    writeFileAtomic(p, output);
  }
  const preview = truncateToTokens(output, PREVIEW_TOKENS);
  return `<persisted-output>\nFull output: ${p}\nPreview:\n${preview}\n</persisted-output>`;
}

/**
 * 单条工具输出截断（CC 1.0.40 实证：>30K 字符就地截断 + [N lines truncated]）。
 * BASH_MAX_OUTPUT_LENGTH env 可覆盖（CC 同款）。
 */
export const CC_TOOL_OUTPUT_LIMIT_CHARS = 30_000;
export function toolOutputLimitChars(): number {
  const env = process.env.BASH_MAX_OUTPUT_LENGTH;
  if (env) {
    const n = parseInt(env, 10);
    if (!Number.isNaN(n) && n > 0) return n;
  }
  return CC_TOOL_OUTPUT_LIMIT_CHARS;
}

export function truncateToolOutput(output: string): string {
  const limit = toolOutputLimitChars();
  if (output.length <= limit) return output;
  const kept = output.slice(0, limit);
  const truncatedLines = output.slice(limit).split("\n").length;
  return `${kept}... [${truncatedLines} lines truncated] ...`;
}

/**
 * 工具输出统一出口（L3）：CC 式截断（>30K 字符 + 标记）+ 落盘叠加
 * （>PERSIST_THRESHOLD tokens 时完整落盘 + 消息内引用/预览，双保险）。
 * 所有本地工具结果经 executeToolCall 出口调用。
 */
export function finalizeToolOutput(
  toolName: string,
  toolCallId: string | undefined,
  output: string,
): string {
  const limited = truncateToolOutput(output);
  if (estimateTokens(output) <= PERSIST_THRESHOLD_TOKENS) return limited;
  const id = toolCallId
    ? `${toolName}_${toolCallId}`
    : `${toolName}_${createHash("md5").update(output).digest("hex").slice(0, 8)}`;
  return persistLargeOutput(id, output); // 完整落盘 + 预览引用
}

// ── L4: 全量/反应式压缩（LLM 摘要；12 中迁移为 compaction entry） ─────────

export function writeTranscript(messages: ChatMessage[]): string {
  const dir = transcriptDir();
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `transcript_${Math.trunc(Date.now() / 1000)}.jsonl`);
  writeFileAtomic(p, messages.map((m) => JSON.stringify(m)).join("\n") + "\n");
  return p;
}

type SummaryOptions = { previousSummary?: string; instructions?: string; signal?: AbortSignal };

/**
 * 构造摘要调用的**完整 prompt**（含输入上限截断）——发送与指纹计算共用同一份，
 * 保证"指纹相同 ⇔ 送给模型的输入一字不差"。
 */
function buildSummaryPrompt(messages: ChatMessage[], options: SummaryOptions = {}, turnPrefix = false): string {
  const render = (conversation: string) => turnPrefix
    ? formatTurnPrefixSummary(conversation, options.instructions)
    : formatCompactSummary(conversation, options.previousSummary, options.instructions);
  let messagesToSummarize = messages;
  const totalEst = estimateMessagesTokens(messages);
  // 模板、旧摘要和额外指令也占输入窗口，不能只给 JSON 对话做预算。
  const inputCap = summarizeInputCap() - estimateTokens(render("[]")) - 64;
  if (inputCap <= 0) throw new Error("Compaction instructions and previous summary exceed the input budget");
  if (totalEst > inputCap) {
    // Keep the initial user specification even when a large tool history evicts it.
    const initial = messages.find(m => m.role === "user");
    const pinned = initial ? { ...initial, content: truncateToTokens(String(initial.content ?? ""), Math.floor(inputCap / 3)) } : null;
    const truncated: ChatMessage[] = [];
    let running = pinned ? estimateMessageTokens(pinned) : 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i] === initial) continue;
      const sz = estimateMessageTokens(messages[i]);
      if (running + sz > inputCap) break;
      truncated.unshift(messages[i]);
      running += sz;
    }
    messagesToSummarize = pinned ? [pinned, ...truncated] : truncated;
  }
  const conversation = JSON.stringify(messagesToSummarize);
  // pi 式模板：<conversation> 包装 + （有旧摘要时）<previous-summary> 更新式
  return render(conversation);
}

/**
 * 摘要输入指纹：prompt 全文（已含对话渲染 / previousSummary / 额外指令 / 模板版本）
 * + 当前模型。换模型或改模板 → 指纹变 → 不复用旧摘要。
 */
function summaryInputHash(prompt: string): string {
  const model = getCurrentModel();
  const modelSpec = model ? `${model.provider}/${model.id}` : "?";
  return createHash("sha256").update(`${modelSpec}\n${prompt}`).digest("hex").slice(0, 32);
}

/** 摘要调用（prompt 已构造好）——复用与新建的唯一出口 */
async function completeSummary(
  prompt: string,
  signal?: AbortSignal,
): Promise<{ summary: string; usage?: import("@earendil-works/pi-ai").Usage }> {
  const r = await completeTextWithUsage(prompt, { maxTokens: summaryOutputBudget(), signal });
  return { summary: r.text || "(empty summary)", ...(r.usage ? { usage: r.usage } : {}) };
}

export async function summarizeHistory(
  messages: ChatMessage[],
  options: SummaryOptions = {},
): Promise<{ summary: string; usage?: import("@earendil-works/pi-ai").Usage }> {
  return completeSummary(buildSummaryPrompt(messages, options), options.signal);
}

/** 全树查同指纹的 compaction entry（同前缀的其它分支 / 更早的同输入压缩） */
function findReusableSummary(
  session: SessionManager,
  inputHash: string,
): { id: string; summary: string } | null {
  for (const e of session.getEntries()) {
    if (e.type === "compaction" && e.inputHash === inputHash) {
      return { id: e.id, summary: e.summary };
    }
  }
  return null;
}

export async function compactHistory(messages: ChatMessage[]): Promise<ChatMessage[]> {
  const compacted = [...messages];
  await compactContext(compacted);
  return compacted;
}

/** 超限恢复也保存同样的安全尾巴/会话检查点，不再直接 slice(-5)。 */
export async function reactiveCompact(messages: ChatMessage[], opts: CompactContextOptions = {}): Promise<ChatMessage[]> {
  const compacted = [...messages];
  await compactContext(compacted, { ...opts, reason: "reactive" });
  return compacted;
}

function combineSummaryUsage(left: Usage | undefined, right: Usage | undefined): Usage | undefined {
  if (!left) return right;
  if (!right) return left;
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    totalTokens: left.totalTokens + right.totalTokens,
    reasoning: (left.reasoning ?? 0) + (right.reasoning ?? 0),
    cost: {
      input: left.cost.input + right.cost.input,
      output: left.cost.output + right.cost.output,
      cacheRead: left.cost.cacheRead + right.cost.cacheRead,
      cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
      total: left.cost.total + right.cost.total,
    },
  };
}

function previousSummaryFromMessage(message: ChatMessage | undefined): string | undefined {
  if (message?.role !== "user" || typeof message.content !== "string") return undefined;
  const prefix = formatCompactedUserMessage("").split("\n</summary>")[0];
  const suffix = "\n</summary>";
  return message.content.startsWith(prefix) && message.content.endsWith(suffix)
    ? message.content.slice(prefix.length, -suffix.length) : undefined;
}

/** 分支内最近 compaction 之后是否存在有效 assistant usage（pi hasPostCompactionUsage 语义）。
 * null=无 compaction；true=已有有效响应；false=压缩后尚无（触发方应等待）。 */
export function hasValidPostCompactionUsage(entries: SessionEntry[]): boolean | null {
  let latestCompactionIdx = -1;
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].type === "compaction") latestCompactionIdx = i;
  }
  if (latestCompactionIdx < 0) return null;
  for (let i = entries.length - 1; i > latestCompactionIdx; i--) {
    const usage = usageOf(entries[i]);
    if (usage && usage.totalTokens > 0) return true;
  }
  return false;
}

function usageOf(entry: SessionEntry): Usage | null {
  if (entry.type === "message") {
    const u = (entry as { message?: { usage?: Usage | null } }).message?.usage;
    return u ?? null;
  }
  if (entry.type === "compaction") {
    return (entry as CompactionEntry).usage ?? null;
  }
  return null;
}
export interface CompactContextOptions {
  session?: SessionManager | null;
  /** 摘要额外关注点（`/compact <指令>` → prompt 的 Additional focus） */
  instructions?: string;
  signal?: AbortSignal;
  reason?: "auto" | "manual" | "reactive";
}

export interface CompactOutcome {
  /** 压缩前上下文 token（真实 usage 优先，无则字符估算） */
  tokensBefore: number;
  /** 压缩后上下文 token（字符估算，供回报/诊断） */
  tokensAfter: number;
  /** 会话路径写入的检查点 entry id；非会话路径无 */
  checkpointId?: string;
  /** 命中复用：本摘要抄自哪个 compaction entry（未复用则缺省） */
  reusedFrom?: string;
  isSplitTurn?: boolean;
  skipped?: boolean;
}

/**
 * 单次压缩执行（**不含阈值门控**）——自动（maybeCompact）与手动（/compact）
 * 共用同一条路径，避免两套语义漂移：
 * - 会话：写 compaction entry（含 retainedTail），并把调用方的 messages 就地
 *   替换为检查点视图（摘要 + 保留尾巴 + 检查点之后的 entry）；
 * - 非会话：同样保留安全尾巴，压缩前完整 transcript 落盘。
 * 失败上抛、**不写 entry**（调用方决定提示文案）。
 */
export async function compactContext(
  messages: ChatMessage[],
  opts: CompactContextOptions = {},
): Promise<CompactOutcome> {
  const session = opts.session ?? null;
  const tokensBefore =
    estimateContextTokensByUsage(messages) ?? estimateMessagesTokens(messages);
  opts.signal?.throwIfAborted();
  const systemMessages = messages.filter(m => m.role === "system");
  const conversation = messages.filter(m => m.role !== "system");
  const leafBefore = session?.getLeafId();
  // previousSummary：分支链上最近 compaction 的摘要（树形检查点链 = 更新式输入）
  const branch = session?.getBranch() ?? [];
  const prev = [...branch].reverse().find((e) => e.type === "compaction") as
    | { summary: string }
    | undefined;
  const inlineSummary = previousSummaryFromMessage(conversation[0]);
  const previousSummary = prev?.summary ?? inlineSummary;
  if (inlineSummary !== undefined) conversation.shift();
  if (!conversation.length) return { tokensBefore, tokensAfter: tokensBefore, skipped: true };
  const preparation = prepareCompaction(conversation, retainedTailBudget());
  const summaryOptions: SummaryOptions = {
    ...(previousSummary !== undefined ? { previousSummary } : {}),
    ...(opts.instructions ? { instructions: opts.instructions } : {}),
  };
  const historyPrompt = preparation.messagesToSummarize.length
    ? buildSummaryPrompt(preparation.messagesToSummarize, summaryOptions) : undefined;
  const turnPrompt = preparation.isSplitTurn
    ? buildSummaryPrompt(preparation.turnPrefixMessages, { instructions: opts.instructions }, true) : undefined;
  // 指纹查重：同前缀（另一条分支 / 更早的同输入压缩）已有摘要 → 直接复用，省一次调用
  const inputHash = summaryInputHash(JSON.stringify({
    version: "split-turn-v1", historyPrompt, turnPrompt,
    ...(historyPrompt ? {} : { previousSummary }),
  }));
  const reusable = session ? findReusableSummary(session, inputHash) : null;
  if (!session) writeTranscript(messages);
  let summary = reusable?.summary ?? previousSummary ?? "No prior history.";
  let usage: Usage | undefined;
  if (!reusable) {
    if (historyPrompt) {
      const history = await completeSummary(historyPrompt, opts.signal);
      summary = history.summary;
      usage = history.usage;
    }
    if (turnPrompt) {
      const turn = await completeSummary(turnPrompt, opts.signal);
      summary += `\n\n---\n\n**Turn Context (split turn):**\n\n${turn.summary}`;
      usage = combineSummaryUsage(usage, turn.usage);
    }
  }
  opts.signal?.throwIfAborted();
  if (session && session.getLeafId() !== leafBefore) throw new Error("Session changed while compacting; retry on the current branch");
  const tail = preparation.retainedTail;
  // 空尾巴也必须写 []：它仍是自包含检查点，恢复不能重新带入被摘要的原文。
  const checkpointId = session?.appendCompaction(summary, tokensBefore, tail, usage, {
    inputHash, isSplitTurn: preparation.isSplitTurn, reason: opts.reason ?? "manual",
    ...(reusable ? { reusedFrom: reusable.id } : {}),
  });
  messages.splice(0, messages.length, ...systemMessages,
    ...(session ? session.buildSessionContext().messages.filter(m => m.role !== "system")
      : [{ role: "user" as const, content: formatCompactedUserMessage(summary) }, ...tail]));
  return {
    tokensBefore,
    tokensAfter: estimateMessagesTokens(messages),
    checkpointId,
    isSplitTurn: preparation.isSplitTurn,
    ...(reusable ? { reusedFrom: reusable.id } : {}),
  };
}

/**
 * 自动压缩统一入口（#7 加深）：门控（阈值估算 + usage 门闩）→ compactContext
 * → 失败内吞（不阻断回合；分类提示）。公共面：一个调用。
 */
export async function maybeCompact(
  messages: ChatMessage[],
  opts: { session?: SessionManager | null; sink?: UiEventSink; signal?: AbortSignal } = {},
): Promise<void> {
  if (!isAutoCompactEnabled()) return;
  const branch = opts.session?.getBranch() ?? null;
  const gate = branch ? hasValidPostCompactionUsage(branch) : null;
  const byUsage = estimateContextTokensByUsage(messages);
  const overThreshold =
    (byUsage ?? estimateMessagesTokens(messages)) > getCompactionThreshold();
  if (gate === false || !overThreshold) return;

  emitNoticeOrLog(opts.sink, "  \x1b[31m[auto compact]\x1b[0m");
  try {
    await compactContext(messages, { session: opts.session, signal: opts.signal, reason: "auto" });
  } catch (e) {
    if (opts.signal?.aborted) return;
    // CC 语义：压缩失败不写 entry、回合继续（不阻断；分类提示）
    emitNoticeOrLog(
      opts.sink,
      `  \x1b[31m[auto compact failed] ${e instanceof Error ? e.message : String(e)}\x1b[0m` +
        " 上下文已超限时请 Esc 后重试或 /compact",
    );
  }
}
