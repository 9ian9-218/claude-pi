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
import { estimateMessagesTokens, hasValidPostCompactionUsage } from "./compact.ts";
export { hasValidPostCompactionUsage } from "./compact.ts";

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

/** 子 agent 编队汇总（用量已并入 totals，这里只带数量用于展示） */
export interface AgentFleetStats {
  count: number;
  running: number;
  /** 子 agent 自身的用量小计（展示用；已计入 totals） */
  usage?: UsageTotals;
}

/** footer 统计数据源：渲染时现算（由 cli 层注入，null = 无会话） */
export interface FooterStats {
  totals: UsageTotals;
  priceUnknown?: boolean;
  /** 最新一条 assistant 的缓存命中率（0-100） */
  latestCacheHitRate?: number;
  context?: ContextUsage;
  branch: string | null;
  /** 子 agent 编队（有 agent 时才带） */
  agents?: AgentFleetStats;
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
