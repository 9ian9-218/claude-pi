/**
 * usage-stats.ts — footer 统计纯函数（对齐 pi footer 语义）
 *
 * 数据源：session branch entries（assistant 消息 usage + compaction usage）。
 * 纯函数、零状态：footer 每次渲染现算（渲染时现算，无事件驱动）。
 * 语义对齐 pi（dist/modes/interactive/components/footer.js）：
 * - totals：全分支累计（↑input ↓output R cacheRead W cacheWrite $ cost）；
 * - CH%：最新一条带 usage 的 assistant 消息的缓存命中率
 *   cacheRead / (input + cacheRead + cacheWrite)；
 * - 上下文 %：estimateMessagesTokens(当前上下文) / model.contextWindow；
 *   最近一次 compaction 之后若无有效 assistant usage → 未知（"?"），
 *   pi 语义（压缩前 usage 反映旧上下文）。cpi 简化：中断回合已由
 *   truncateTo 回滚，任何带 usage 的 assistant entry 均视为有效。
 */
import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry, CompactionEntry } from "./session-manager.ts";
import type { ChatMessage } from "./client.ts";
import { estimateMessagesTokens } from "./compact.ts";

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

/** footer 统计数据源：渲染时现算（由 cli 层注入，null = 无会话） */
export interface FooterStats {
  totals: UsageTotals;
  /** 最新一条 assistant 的缓存命中率（0-100） */
  latestCacheHitRate?: number;
  context?: ContextUsage;
  branch: string | null;
}

export function emptyTotals(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function addUsage(totals: UsageTotals, usage: Usage): void {
  totals.input += usage.input;
  totals.output += usage.output;
  totals.cacheRead += usage.cacheRead;
  totals.cacheWrite += usage.cacheWrite;
  totals.cost += usage.cost?.total ?? 0;
}

function usageOf(entry: SessionEntry): Usage | undefined {
  if (entry.type === "message" && entry.message.role === "assistant") {
    return (entry.message as ChatMessage & { usage?: Usage }).usage;
  }
  if (entry.type === "compaction") {
    return (entry as CompactionEntry).usage;
  }
  return undefined;
}

/** 全分支累计 totals（assistant 消息 + compaction 摘要） */
export function computeUsageTotals(entries: SessionEntry[]): UsageTotals {
  const totals = emptyTotals();
  for (const entry of entries) {
    const usage = usageOf(entry);
    if (usage) addUsage(totals, usage);
  }
  return totals;
}

/** 最新一条带 usage 的 assistant 消息的缓存命中率（0-100）；无则 undefined */
export function latestCacheHitRate(entries: SessionEntry[]): number | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const usage = usageOf(entries[i]);
    if (!usage) continue;
    const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
    if (promptTokens > 0) {
      return (usage.cacheRead / promptTokens) * 100;
    }
  }
  return undefined;
}

export interface ContextUsage {
  /** 当前上下文估算 token 数；压缩后未知为 null */
  tokens: number | null;
  /** 占窗口百分比（0-100）；未知为 null */
  percent: number | null;
  contextWindow: number;
}

/**
 * 分支内最近 compaction 之后是否存在有效 assistant usage（pi 的
 * hasPostCompactionUsage 语义）。
 * - null：分支无 compaction（门闩不限制）；
 * - true：压缩后已有有效响应（上下文量可知）；
 * - false：压缩后尚无有效响应（上下文量未知——触发方应等待）。
 * 有效 = usage.totalTokens > 0 的 assistant 消息。中断/出错回合已被
 * truncateTo 回滚，无需 pi 的 stopReason 过滤。
 */
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

/**
 * 上下文占用（pi 语义）：
 * - contextWindow <= 0 → undefined（不显示）；
 * - 分支内最近一次 compaction 之后无有效 assistant usage → { tokens: null, percent: null }；
 * - 否则 percent = estimateMessagesTokens(messages) / contextWindow * 100。
 */
export function computeContextUsage(
  entries: SessionEntry[],
  messages: ChatMessage[],
  contextWindow: number,
): ContextUsage | undefined {
  if (contextWindow <= 0) return undefined;

  const gate = hasValidPostCompactionUsage(entries);
  if (gate === false) {
    return { tokens: null, percent: null, contextWindow };
  }

  const tokens = estimateMessagesTokens(messages);
  return { tokens, percent: (tokens / contextWindow) * 100, contextWindow };
}
