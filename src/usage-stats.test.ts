import { describe, it, expect } from "vitest";
import {
  computeUsageTotals,
  latestCacheHitRate,
  computeContextUsage,
} from "./usage-stats.ts";
import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "./session-manager.ts";
import type { ChatMessage } from "./client.ts";

function entry(over: Partial<SessionEntry> & { type: string; id: string; parentId: string | null; timestamp: string }): SessionEntry {
  return over as SessionEntry;
}

function assistant(id: string, usage: unknown, parentId: string | null = null): SessionEntry {
  return entry({
    type: "message",
    id,
    parentId,
    timestamp: "t",
    message: { role: "assistant", content: "hi", ...(usage ? { usage } : {}) } as ChatMessage,
  });
}

function compaction(id: string, usage?: Usage): SessionEntry {
  return entry({
    type: "compaction",
    id,
    parentId: null,
    timestamp: "t",
    summary: "sum",
    tokensBefore: 1000,
    ...(usage ? { usage } : {}),
  });
}

const u = (input: number, output: number, cacheRead = 0, cacheWrite = 0, cost = 0): Usage => ({
  input,
  output,
  cacheRead,
  cacheWrite,
  totalTokens: input + output + cacheRead + cacheWrite,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});

describe("computeUsageTotals（footer 统计累计）", () => {
  it("累加 assistant + compaction 的 usage；无 usage 的老 entry 跳过", () => {
    const entries = [
      assistant("a1", u(100, 50, 200, 10, 0.001)),
      assistant("a2", undefined), // 老会话：无 usage
      compaction("c1", u(300, 80, 0, 0, 0.002)),
      { type: "message", id: "a3", parentId: null, timestamp: "t", message: { role: "user", content: "q" } },
    ] as SessionEntry[];
    const t = computeUsageTotals(entries);
    expect(t.input).toBe(400);
    expect(t.output).toBe(130);
    expect(t.cacheRead).toBe(200);
    expect(t.cacheWrite).toBe(10);
    expect(t.cost).toBeCloseTo(0.003);
  });

  it("空/全无 usage → 全 0", () => {
    const t = computeUsageTotals([]);
    expect(t).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
  });
});

describe("latestCacheHitRate（最新一条命中率）", () => {
  it("取最新一条带 usage 的 assistant 消息", () => {
    const entries = [
      assistant("a1", u(100, 50, 900, 0)), // 命中率 90%
      assistant("a2", u(100, 50, 9900, 0)), // 命中率 99%
      assistant("a3", undefined), // 无 usage，跳过
    ] as SessionEntry[];
    expect(latestCacheHitRate(entries)).toBeCloseTo(99);
  });

  it("无任何 usage → undefined", () => {
    expect(latestCacheHitRate([])).toBeUndefined();
  });
});

describe("computeContextUsage（上下文 %/窗口，pi 语义）", () => {
  const msgs: ChatMessage[] = [{ role: "user", content: "你好，这是一段用于估算的中文内容。" }];

  it("窗口 <= 0 → undefined（不显示）", () => {
    expect(computeContextUsage([], msgs, 0)).toBeUndefined();
    expect(computeContextUsage([], msgs, -1)).toBeUndefined();
  });

  it("无压缩：估算值/窗口", () => {
    const r = computeContextUsage([assistant("a1", u(10, 10))], msgs, 1_000_000)!;
    expect(r.tokens).toBeGreaterThan(0);
    expect(r.percent).toBeCloseTo((r.tokens! / 1_000_000) * 100, 5);
    expect(r.contextWindow).toBe(1_000_000);
  });

  it("压缩后无有效 assistant usage → tokens/percent 为 null（?/窗口）", () => {
    const entries = [
      assistant("old", u(9000, 100)), // 压缩前 usage（反映旧上下文）
      compaction("c1", u(100, 50)), // 压缩
      assistant("new", undefined), // 压缩后但无 usage（模拟刚恢复/中断）
    ] as SessionEntry[];
    const r = computeContextUsage(entries, msgs, 1_000_000)!;
    expect(r.tokens).toBeNull();
    expect(r.percent).toBeNull();
  });

  it("压缩后存在有效 assistant usage → 显示估算", () => {
    const entries = [
      compaction("c1", u(100, 50)),
      assistant("new", u(50, 20)), // 压缩后有效
    ] as SessionEntry[];
    const r = computeContextUsage(entries, msgs, 1_000_000)!;
    expect(r.percent).not.toBeNull();
  });
});
