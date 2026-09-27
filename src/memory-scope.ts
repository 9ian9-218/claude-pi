/**
 * memory-scope.ts — 会话级记忆快照（前缀稳定性）
 *
 * 一个「会话」= 该会话及其派生的 subagent / teammate，共享同一份记忆快照：
 * 首次进入会话时把（MEMORY.md 索引 + 相关性检索出的记忆正文）冻结，之后所有请求
 * 都用这份快照拼 system 提示 —— system 逐字节稳定，prompt cache 前缀可复用。
 *
 * 本会话内由 Stop hook 抽取/更新进记忆库的新记忆**不影响当前会话**（快照已冻结），
 * 只在下一次「新会话」生效：新会话 = 新 sessionId = 新 scope = 新快照。
 *
 * 开关：settings.memory.enabled === false ⇒ 快照为空，且停止记忆提取。
 */
import { isMemoryEnabled } from "./settings.ts";
import { loadMemories, readMemoryIndex } from "./memory.ts";
import type { ChatMessage } from "./client.ts";

export interface MemorySnapshot {
  /** MEMORY.md 索引文本 */
  index: string;
  /** 相关性检索出的记忆正文（含 <relevant_memories> 包裹） */
  injected: string;
}

const EMPTY: MemorySnapshot = { index: "", injected: "" };

let processScopeId = "ephemeral";
const snapshots = new Map<string, MemorySnapshot>();

/** 绑定当前会话 scope（不同 sessionId ⇒ 不同快照 ⇒ 新会话拿到新记忆） */
export function setMemoryScopeId(id: string | null | undefined): void {
  if (typeof id === "string" && id.trim()) processScopeId = id;
}

export function getMemoryScopeId(): string {
  return processScopeId;
}

/**
 * 显式刷新当前 scope 的快照（/memory-refresh）。
 * 立即用最新记忆库重算：本会话马上看到新记忆，代价是**前缀变化**——
 * 之前缓存的 system/消息前缀从下一次请求起不再复用，新前缀重新累积缓存。
 */
export async function refreshMemorySnapshot(
  seedMessages: ChatMessage[] = [],
  scopeId?: string | null,
): Promise<MemorySnapshot> {
  if (scopeId) setMemoryScopeId(scopeId);
  if (!isMemoryEnabled()) {
    snapshots.set(processScopeId, EMPTY);
    return EMPTY;
  }
  const snapshot: MemorySnapshot = {
    index: readMemoryIndex(),
    injected: await loadMemories(seedMessages),
  };
  snapshots.set(processScopeId, snapshot);
  return snapshot;
}

/** 测试隔离：清空所有快照 */
export function resetMemorySnapshots(): void {
  snapshots.clear();
  processScopeId = "ephemeral";
}

/**
 * 同步读取当前 scope 的快照（供 system 提示组装）。
 * 未 prime 时只回索引、不触发检索 LLM 调用，也不缓存（留给 prime 补全正文）。
 */
export function peekMemorySnapshot(): MemorySnapshot {
  const cached = snapshots.get(processScopeId);
  if (cached) return cached;
  if (!isMemoryEnabled()) return EMPTY;
  return { index: readMemoryIndex(), injected: "" };
}

/**
 * 冻结当前 scope 的快照（每个 scope 只计算一次）。
 * 由 agent-loop 在进入循环前调用；subagent / teammate 复用同一 scope，不重算。
 */
export async function primeMemorySnapshot(
  seedMessages: ChatMessage[],
  scopeId?: string | null,
): Promise<MemorySnapshot> {
  if (scopeId) setMemoryScopeId(scopeId);
  const cached = snapshots.get(processScopeId);
  if (cached) return cached;
  let snapshot = EMPTY;
  if (isMemoryEnabled()) {
    snapshot = { index: readMemoryIndex(), injected: await loadMemories(seedMessages) };
  }
  snapshots.set(processScopeId, snapshot);
  return snapshot;
}
