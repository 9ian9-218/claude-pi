/**
 * compact.ts — 上下文压缩（对齐 src/compact.py）
 *
 * L1 Snip（裁剪中间消息）、L2 Micro（旧结果占位）、L3 Budget（超大结果落盘）、
 * L4 全量/反应式压缩（LLM 摘要）。
 * 04 交付 L1–L3 + reactive/compactHistory（LLM 摘要走 client）；
 * L4 与会话树 compaction entry 的联动归工单 12。
 */
import fs from "node:fs";
import path from "node:path";
import { getWorkdir } from "./workdir.ts";
import { completeText, type ChatMessage } from "./client.ts";
import {
  formatCompactedUserMessage,
  formatReactiveCompactedUserMessage,
  formatSnippedUserMessage,
  formatCompactSummary,
} from "./prompt.ts";

// 窗口参数（对齐 compact.py 1M 参考值对应的 600K 配置）
export const MODEL_MAX_CONTEXT_TOKENS = 600_000;
export const AUTOCOMPACT_BUFFER_TOKENS = 30_000;
export const BUDGET_MAX_TOKENS = 120_000;
export const PERSIST_THRESHOLD_TOKENS = 6_000;
export const PREVIEW_TOKENS = 500;
export const MAX_NUM_MESSAGES = 240;
export const MICRO_COMPACT_MAX_MESSAGE_TOKENS = 8_000;
export const MICRO_COMPACT_KEEP_RECENT_TOOL_RESULTS = 10;
export const CONTEXT_LIMIT = 480_000;
export const AUTO_COMPACT_MAX_INPUT_TOKENS_EST = 240_000;
export const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 12_000;
export const MAX_REACTIVE_RETRIES = 2;

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

// ── 轮次工具 ──────────────────────────────────────────────────────────────

export function _splitRounds(body: ChatMessage[]): ChatMessage[][] {
  const rounds: ChatMessage[][] = [];
  let i = 0;
  const n = body.length;
  while (i < n) {
    const start = i;
    const msg = body[i];
    i += 1;
    if (msg.role === "assistant" && msg.tool_calls) {
      while (i < n && body[i].role === "tool") i += 1;
    }
    rounds.push(body.slice(start, i));
  }
  return rounds;
}

function _flattenRounds(rounds: ChatMessage[][]): ChatMessage[] {
  return rounds.flat();
}

export function _validateToolPairing(messages: ChatMessage[]): void {
  let i = 0;
  const n = messages.length;
  while (i < n) {
    const msg = messages[i];
    if (msg.role === "assistant" && msg.tool_calls) {
      const expected = new Set(
        (msg.tool_calls as Array<{ id?: string }>).map((tc) => tc.id),
      );
      i += 1;
      const seen = new Set<string>();
      while (i < n && messages[i].role === "tool") {
        seen.add(messages[i].tool_call_id ?? "");
        i += 1;
      }
      if (JSON.stringify([...expected]) !== JSON.stringify([...seen])) {
        throw new Error(`tool_call pairing broken: expected ${[...expected]}, got ${[...seen]}`);
      }
    } else {
      i += 1;
    }
  }
}

// ── L1: snip ──────────────────────────────────────────────────────────────

export function snipCompact(messages: ChatMessage[], maxMessages = MAX_NUM_MESSAGES): ChatMessage[] {
  if (messages.length <= maxMessages) return messages;

  let prefix: ChatMessage[] = [];
  let body = messages;
  if (messages.length > 0 && messages[0].role === "system") {
    prefix = [messages[0]];
    body = messages.slice(1);
  }

  const rounds = _splitRounds(body);
  if (rounds.length <= 1) return messages;

  let headIdx = 0;
  let headLen = prefix.length;
  for (const r of rounds) {
    const nextLen = headLen + r.length;
    if (nextLen + 1 + 1 > maxMessages) break; // 留 1 占位 + 至少 1 条 tail
    headLen = nextLen;
    headIdx += 1;
  }
  if (headIdx === 0) {
    headIdx = 1;
    headLen = prefix.length + rounds[0].length;
  }

  const tailBudget = maxMessages - headLen - 1;
  const tailRounds: ChatMessage[][] = [];
  let tailLen = 0;
  for (let i = rounds.length - 1; i >= headIdx; i--) {
    const r = rounds[i];
    if (tailLen + r.length > tailBudget && tailRounds.length > 0) break;
    tailRounds.unshift(r);
    tailLen += r.length;
  }
  if (tailRounds.length === 0) {
    tailRounds.push(rounds[rounds.length - 1]);
  }

  let tailIdx = rounds.length - tailRounds.length;
  if (tailIdx <= headIdx) return messages;

  while (tailIdx > headIdx + 1) {
    const snipped = rounds.slice(headIdx, tailIdx).reduce((sum, r) => sum + r.length, 0);
    const result: ChatMessage[] = [...prefix, ..._flattenRounds(rounds.slice(0, headIdx))];
    result.push({ role: "user", content: formatSnippedUserMessage(snipped) });
    result.push(..._flattenRounds(rounds.slice(tailIdx)));
    try {
      _validateToolPairing(result);
    } catch {
      return messages;
    }
    if (result.length <= maxMessages) return result;
    tailIdx -= 1;
  }
  return messages;
}

// ── L2: micro ─────────────────────────────────────────────────────────────

export function collectToolResults(messages: ChatMessage[]): Array<[number, ChatMessage]> {
  const results: Array<[number, ChatMessage]> = [];
  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi];
    if (msg.role !== "tool") continue;
    if (typeof msg.content !== "string") continue;
    results.push([mi, msg]);
  }
  return results;
}

export function microCompact(messages: ChatMessage[]): ChatMessage[] {
  const toolResults = collectToolResults(messages);
  if (toolResults.length <= MICRO_COMPACT_KEEP_RECENT_TOOL_RESULTS) return messages;
  for (const [, msg] of toolResults.slice(0, -MICRO_COMPACT_KEEP_RECENT_TOOL_RESULTS)) {
    if (typeof msg.content === "string" && estimateTokens(msg.content) > MICRO_COMPACT_MAX_MESSAGE_TOKENS) {
      msg.content = "[Earlier tool result compacted. Re-run if needed.]";
    }
  }
  return messages;
}

// ── L3: budget ────────────────────────────────────────────────────────────

export function _trailingToolMessages(messages: ChatMessage[]): number[] {
  const indices: number[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "tool" || typeof msg.content !== "string") break;
    indices.push(i);
  }
  return indices.reverse();
}

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

export function toolResultBudget(messages: ChatMessage[], maxTokens = BUDGET_MAX_TOKENS): ChatMessage[] {
  const indices = _trailingToolMessages(messages);
  if (indices.length === 0) return messages;
  const toolMsgs = indices.map((i) => messages[i]);
  let totalTokens = toolMsgs.reduce((sum, m) => sum + estimateTokens(String(m.content)), 0);
  if (totalTokens <= maxTokens) return messages;
  const ranked = [...toolMsgs].sort(
    (a, b) => estimateTokens(String(b.content)) - estimateTokens(String(a.content)),
  );
  for (const msg of ranked) {
    if (totalTokens <= maxTokens) break;
    const content = String(msg.content);
    if (estimateTokens(content) <= PERSIST_THRESHOLD_TOKENS) continue;
    const tid = msg.tool_call_id ?? "unknown";
    msg.content = persistLargeOutput(tid, content);
    totalTokens = toolMsgs.reduce((sum, m) => sum + estimateTokens(String(m.content)), 0);
  }
  return messages;
}

// ── L4: 全量/反应式压缩（LLM 摘要；12 中迁移为 compaction entry） ─────────

export function writeTranscript(messages: ChatMessage[]): string {
  const dir = transcriptDir();
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `transcript_${Math.trunc(Date.now() / 1000)}.jsonl`);
  fs.writeFileSync(p, messages.map((m) => JSON.stringify(m)).join("\n") + "\n");
  return p;
}

export async function summarizeHistory(messages: ChatMessage[]): Promise<string> {
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
  const prompt = formatCompactSummary(conversation);
  return (await completeText(prompt, { maxTokens: MAX_OUTPUT_TOKENS_FOR_SUMMARY })) || "(empty summary)";
}

export async function compactHistory(messages: ChatMessage[]): Promise<ChatMessage[]> {
  const transcriptPath = writeTranscript(messages);
  console.log(`[transcript saved: ${transcriptPath}]`);
  const summary = await summarizeHistory(messages);
  return [{ role: "user", content: formatCompactedUserMessage(summary) }];
}

export async function reactiveCompact(messages: ChatMessage[]): Promise<ChatMessage[]> {
  writeTranscript(messages);
  const summary = await summarizeHistory(messages);
  return [
    { role: "user", content: formatReactiveCompactedUserMessage(summary) },
    ...messages.slice(-5),
  ];
}
