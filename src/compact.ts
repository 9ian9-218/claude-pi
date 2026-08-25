/**
 * compact.ts — 上下文压缩（CC 语义 + pi 式摘要）
 *
 * 阶段 0（04）：L1–L3 压缩 + reactive/compactHistory；
 * 缓存优化（grill 共识 v3）：L1/L2 移除（CC 无对应物）；L3 = 工具输出
 * 统一出口截断（>30K 字符 + 落盘引用）；L4 = window 驱动触发（kE 真实
 * usage + 0.92 系数）+ pi 式 7 节摘要（previousSummary 更新式）。
 * L4 与会话树 compaction entry 的联动归工单 12。
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { getWorkdir } from "./workdir.ts";
import { completeTextWithUsage, type ChatMessage } from "./client.ts";
import { getCurrentModel } from "./ai-runtime.ts";
import { readPiSettings, DEFAULT_COMPACTION } from "./settings.ts";
import {
  formatCompactedUserMessage,
  formatReactiveCompactedUserMessage,
  formatCompactSummary,
} from "./prompt.ts";

// 窗口参数（对齐 compact.py 1M 参考值对应的 600K 配置）
export const MODEL_MAX_CONTEXT_TOKENS = 600_000;
export const PERSIST_THRESHOLD_TOKENS = 6_000;
export const PREVIEW_TOKENS = 500;
// 摘要输出预算（对齐 CC 1.0.40 实证 PM2=20000）
export const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000;
/** retainedTail 预算（对齐 pi keepRecentTokens 默认 20000） */
export const DEFAULT_KEEP_RECENT_TOKENS = DEFAULT_COMPACTION.keepRecentTokens;
export const AUTO_COMPACT_MAX_INPUT_TOKENS_EST = 240_000;
export const MAX_REACTIVE_RETRIES = 2;

/**
 * maxOutput 预留（CC 1.0.40 实证 PAA）：有效窗口 = contextWindow − 预留。
 * 模型 id 含 "3-5"/"haiku" → 8192；CLAUDE_CODE_MAX_OUTPUT_TOKENS env 可覆盖；默认 32000。
 */
export function maxOutputReserve(modelId?: string): number {
  const id = modelId ?? getCurrentModel()?.id ?? "";
  if (id.includes("3-5") || id.includes("haiku")) return 8192;
  const env = process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
  if (env) {
    const n = parseInt(env, 10);
    if (!Number.isNaN(n) && n > 0) return n;
  }
  return 32_000;
}

/**
 * 自动压缩触发阈值（CC 式：kE ≥ pct × (window − maxOutput 预留)）。
 * window 优先取当前模型 contextWindow；兜底 MODEL_MAX_CONTEXT_TOKENS；
 * pct 默认 0.92（CC LA1 实证），settings.compaction.autoCompactPct 可覆盖。
 */
export function getCompactionThreshold(window?: number, pct?: number): number {
  const win = window ?? getCurrentModel()?.contextWindow ?? MODEL_MAX_CONTEXT_TOKENS;
  const settings = readPiSettings().compaction;
  const rate = pct ?? settings?.autoCompactPct ?? DEFAULT_COMPACTION.autoCompactPct;
  return Math.max(1, Math.round((win - maxOutputReserve(getCurrentModel()?.id)) * rate));
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
      if (t > 0) return t;
    }
  }
  return null;
}

/**
 * retainedTail 预算化（对齐 pi keepRecentTokens）：从尾向前保留，
 * 累计不超过 budgetTokens；单条超预算也保留（无法更小）。
 */
export function pickRetainedTail(messages: ChatMessage[], budgetTokens: number): ChatMessage[] {
  const tail: ChatMessage[] = [];
  let running = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const sz = estimateMessageTokens(messages[i]);
    if (running + sz > budgetTokens && tail.length > 0) break;
    tail.unshift(messages[i]);
    running += sz;
  }
  return tail;
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
    fs.writeFileSync(p, output);
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
  fs.writeFileSync(p, messages.map((m) => JSON.stringify(m)).join("\n") + "\n");
  return p;
}

export async function summarizeHistory(
  messages: ChatMessage[],
  options: { previousSummary?: string; instructions?: string } = {},
): Promise<{ summary: string; usage?: import("@earendil-works/pi-ai").Usage }> {
  let messagesToSummarize = messages;
  const totalEst = estimateMessagesTokens(messages);
  if (totalEst > AUTO_COMPACT_MAX_INPUT_TOKENS_EST) {
    const truncated: ChatMessage[] = [];
    let running = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      const sz = estimateMessageTokens(messages[i]);
      if (running + sz > AUTO_COMPACT_MAX_INPUT_TOKENS_EST) break;
      truncated.unshift(messages[i]);
      running += sz;
    }
    messagesToSummarize = truncated;
  }
  const conversation = JSON.stringify(messagesToSummarize);
  // pi 式模板：<conversation> 包装 + （有旧摘要时）<previous-summary> 更新式
  const prompt = formatCompactSummary(conversation, options.previousSummary, options.instructions);
  const r = await completeTextWithUsage(prompt, { maxTokens: MAX_OUTPUT_TOKENS_FOR_SUMMARY });
  return { summary: r.text || "(empty summary)", ...(r.usage ? { usage: r.usage } : {}) };
}

export async function compactHistory(messages: ChatMessage[]): Promise<ChatMessage[]> {
  const transcriptPath = writeTranscript(messages);
  console.log(`[transcript saved: ${transcriptPath}]`);
  const { summary } = await summarizeHistory(messages);
  return [{ role: "user", content: formatCompactedUserMessage(summary) }];
}

export async function reactiveCompact(messages: ChatMessage[]): Promise<ChatMessage[]> {
  writeTranscript(messages);
  const { summary } = await summarizeHistory(messages);
  return [
    { role: "user", content: formatReactiveCompactedUserMessage(summary) },
    ...messages.slice(-5),
  ];
}
