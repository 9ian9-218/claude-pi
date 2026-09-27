/**
 * cache-stats.ts — 缓存命中诊断（对齐 pi cache-stats.js 语义）
 *
 * 度量：相对上一轮请求，本应命中缓存（上轮 prompt 中的 token）却重计费的量。
 * - idle TTL：5 分钟（Anthropic 自动缓存默认 TTL）——间隔超过视为大概率 miss 原因；
 * - 噪声下限：missedTokens <= 1024 忽略（缓存断点粒度噪声）；
 * - compaction/branch_summary 是合法切割 → 重置 prev（下一轮是新内容，不算 miss）；
 * - 只统计曾报告过缓存活动的 provider（从未报缓存 = 不支持，不计）。
 * cpi 与 pi 的差异：cpi 的 assistant entry 无模型字段（只有 model_change entry），
 * 故不报 modelChanged 原因（pi 有）；idle 原因照报。
 */
import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "./session-manager.ts";
import type { ChatMessage } from "./client.ts";

/** 自动缓存 TTL（Anthropic 默认 5 分钟；idle 超过此值值得作为 miss 原因提示） */
export const CACHE_TTL_MS = 5 * 60 * 1000;
/** 单次 miss 低于此值视为缓存断点粒度噪声，不计 */
export const NOISE_FLOOR_TOKENS = 1024;

export interface CacheMissInfo {
  /** 本应命中却重计费的 prompt tokens */
  missedTokens: number;
  /** 按实际付费价差估算的额外成本（usage.cost 可得时；否则 0） */
  missedCost: number;
  /** 距上一轮请求的 idle 间隔 ms（> CACHE_TTL_MS 即可能为 miss 原因） */
  idleMs: number;
}

export interface CacheMissTotals {
  missedTokens: number;
  missedCost: number;
  missCount: number;
}

interface PrevRequest {
  promptTokens: number;
  timestamp: number;
  reportedCache: boolean;
}

function usageOf(entry: SessionEntry): Usage | undefined {
  if (entry.type === "message" && entry.message.role === "assistant") {
    return (entry.message as ChatMessage & { usage?: Usage }).usage;
  }
  if (entry.type === "compaction") {
    return (entry as { usage?: Usage }).usage;
  }
  return undefined;
}

function promptTokensOf(usage: Usage): number {
  return usage.input + usage.cacheRead + usage.cacheWrite;
}

function asPreviousRequest(message: SessionEntry, reportedCache: boolean): PrevRequest | undefined {
  const usage = usageOf(message);
  if (!usage) return undefined;
  const promptTokens = promptTokensOf(usage);
  if (promptTokens <= 0) return undefined;
  return {
    promptTokens,
    timestamp: Date.parse(message.timestamp) || 0,
    reportedCache: reportedCache || usage.cacheRead + usage.cacheWrite > 0,
  };
}

/** 判定一次 miss：上轮 prompt 在本轮重计费的部分（剔除噪声/无缓存活动） */
export function detectCacheMissCore(
  prev: PrevRequest | undefined,
  usage: Usage,
  timestamp: number,
): CacheMissInfo | undefined {
  const promptTokens = promptTokensOf(usage);
  // 首轮 / 无输入 / 从未见过缓存活动（provider 不支持）→ 不计
  if (!prev || promptTokens <= 0 || (usage.cacheRead + usage.cacheWrite === 0 && !prev.reportedCache)) {
    return undefined;
  }
  const missedTokens = Math.min(prev.promptTokens, promptTokens) - usage.cacheRead;
  if (missedTokens <= NOISE_FLOOR_TOKENS) return undefined;
  // 额外成本按本消息的付费桶（input+cacheWrite）与缓存读桶的价差估算
  const paidTokens = usage.input + usage.cacheWrite;
  const paidPerToken =
    paidTokens > 0 ? (usage.cost.input + usage.cost.cacheWrite) / paidTokens : 0;
  const readPerToken = usage.cacheRead > 0 ? usage.cost.cacheRead / usage.cacheRead : 0;
  return {
    missedTokens,
    missedCost: missedTokens * Math.max(0, paidPerToken - readPerToken),
    idleMs: Math.max(0, timestamp - prev.timestamp),
  };
}

interface ScanResult {
  prev: PrevRequest | undefined;
  totals: CacheMissTotals;
}

function scan(entries: SessionEntry[]): ScanResult {
  let prev: PrevRequest | undefined;
  const totals: CacheMissTotals = { missedTokens: 0, missedCost: 0, missCount: 0 };
  for (const entry of entries) {
    if (entry.type === "compaction" || entry.type === "branch_summary") {
      // 上下文合法切割：下一轮是新内容，不算 miss（model 切换 pi 计、cpi 无字段省略）
      prev = undefined;
      continue;
    }
    if (entry.type === "message" && entry.message.role === "assistant") {
      const usage = usageOf(entry);
      if (usage) {
        const miss = detectCacheMissCore(prev, usage, Date.parse(entry.timestamp) || 0);
        if (miss) {
          totals.missedTokens += miss.missedTokens;
          totals.missedCost += miss.missedCost;
          totals.missCount += 1;
        }
      }
      prev = asPreviousRequest(entry, prev?.reportedCache ?? false) ?? prev;
    }
  }
  return { prev, totals };
}


/**
 * 检测刚完成的 assistant 消息是否 miss（入口契约同 pi：entries 尚未包含该消息）
 * @param entries 当前分支 entries（不含 message）
 * @param usage 刚完成消息的 usage
 * @param timestamp 消息时间戳（ms）
 */
export function detectCacheMiss(
  entries: SessionEntry[],
  usage: Usage,
  timestamp: number,
): CacheMissInfo | undefined {
  return detectCacheMissCore(scan(entries).prev, usage, timestamp);
}