/**
 * agent-registry.ts — 多 agent 运行注册表（可观测性事实源）
 *
 * 记录每次 spawn 出来的 agent（subagent 与 5 个专职角色）：角色、状态、轮数、
 * 工具次数、最近动作、子会话文件。生产路径写入，TUI AgentPanel 与 /agents 命令
 * 订阅读取（渲染时现算）。
 *
 * 纯内存：跨进程/事后复查走子会话文件（SessionManager），本模块不落盘。
 */
import type { AgentRole } from "./teammates/context.ts";

export type AgentRunStatus = "running" | "done" | "failed";

/** 子 agent 自身会话累计用量（token / 成本），由子会话 entry 聚合得到 */
export interface AgentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export function emptyAgentUsage(): AgentUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

export interface AgentRun {
  /** 运行 id（如 scout-1a2b3c4d），与子会话一一对应 */
  id: string;
  role: AgentRole;
  /** 一行展示名：角色 + 任务摘要 */
  label: string;
  status: AgentRunStatus;
  startedAt: number;
  endedAt?: number;
  turns: number;
  toolCalls: number;
  /** 最近一次工具调用的名字（折叠面板用） */
  lastTool?: string;
  /** 最近流式文本（截断，仅作预览） */
  lastText?: string;
  /** 子会话标识（落盘，可 /resume 或 --session <id> 复查） */
  sessionId?: string;
  sessionFile?: string;
  /** 父会话文件（血缘） */
  parentSessionFile?: string;
  /** 该 agent 子会话累计用量（token/成本） */
  usage?: AgentUsage;
  /**
   * 持久 agent（teammate）的运行阶段：working=正在执行任务，idle=空闲待命。
   * 一次性 subagent 不设置（其生命周期只有 running → done）。
   */
  phase?: "working" | "idle";
  /**
   * 首轮（第一次 LLM 调用）的缓存读写：cacheRead > 0 即说明复用了父会话前缀。
   * 这是「fork 是否真的命中 prompt cache」的现场证据。
   */
  firstTurnCache?: { cacheRead: number; cacheWrite: number };
  /** 最终交付物（截断） */
  result?: string;
  /** 结束原因（如「空闲超过 30 分钟，已结束」）；一次性 subagent 可不填 */
  endReason?: string;
  error?: string;
}

/** 面板预览用的文本上限 */
export const AGENT_TEXT_PREVIEW = 120;
export const AGENT_RESULT_PREVIEW = 400;
/** 注册表最多保留的最近运行数（防止长会话无限增长） */
export const MAX_AGENT_RUNS = 50;
/** 流式文本更新合并窗口：避免每个 token 都触发一次重绘 */
export const AGENT_NOTIFY_THROTTLE_MS = 120;

const runs = new Map<string, AgentRun>();
const listeners = new Set<(runs: AgentRun[]) => void>();
let lastTextNotifyAt = 0;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 列表快照：按开始时间升序（旧 → 新），只保留最近 MAX_AGENT_RUNS 条 */
export function listAgentRuns(): AgentRun[] {
  return [...runs.values()]
    .sort((a, b) => a.startedAt - b.startedAt)
    .slice(-MAX_AGENT_RUNS);
}

function notify(): void {
  const snapshot = listAgentRuns();
  for (const listener of listeners) listener(snapshot);
}

/** 订阅运行变化（TUI 面板/命令用）；返回取消订阅函数 */
export function subscribeAgentRuns(listener: (runs: AgentRun[]) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function startAgentRun(init: {
  id: string;
  role: AgentRole;
  label: string;
  sessionId?: string;
  sessionFile?: string;
  parentSessionFile?: string;
}): AgentRun {
  const run: AgentRun = {
    id: init.id,
    role: init.role,
    label: init.label,
    status: "running",
    startedAt: Date.now(),
    turns: 0,
    toolCalls: 0,
    ...(init.sessionId !== undefined ? { sessionId: init.sessionId } : {}),
    ...(init.sessionFile !== undefined ? { sessionFile: init.sessionFile } : {}),
    ...(init.parentSessionFile !== undefined ? { parentSessionFile: init.parentSessionFile } : {}),
  };
  runs.set(run.id, run);
  if (runs.size > MAX_AGENT_RUNS) {
    // 从全量里挑最旧的（优先已结束的运行）；注意不能用 listAgentRuns()——
    // 它已经按上限切片，切片后看不到真正最旧的那条
    const all = [...runs.values()].sort((a, b) => a.startedAt - b.startedAt);
    const victim = all.find((r) => r.status !== "running") ?? all[0];
    if (victim && victim.id !== run.id) runs.delete(victim.id);
  }
  notify();
  return run;
}

export function updateAgentRun(id: string, patch: Partial<AgentRun>): AgentRun | null {
  const run = runs.get(id);
  if (!run) return null;
  Object.assign(run, patch);
  notify();
  return run;
}

/** 流式文本增量（节流通知，避免逐 token 重绘） */
export function appendAgentText(id: string, delta: string): void {
  const run = runs.get(id);
  if (!run || !delta) return;
  run.lastText = clip(`${run.lastText ?? ""}${delta}`, AGENT_TEXT_PREVIEW);
  const now = Date.now();
  if (now - lastTextNotifyAt >= AGENT_NOTIFY_THROTTLE_MS) {
    lastTextNotifyAt = now;
    notify();
  }
}

export function finishAgentRun(
  id: string,
  outcome: {
    status: Exclude<AgentRunStatus, "running">;
    result?: string;
    error?: string;
    reason?: string;
  },
): AgentRun | null {
  const run = runs.get(id);
  if (!run) return null;
  run.status = outcome.status;
  run.endedAt = Date.now();
  delete run.phase;
  if (outcome.result !== undefined) run.result = clip(outcome.result, AGENT_RESULT_PREVIEW);
  if (outcome.error !== undefined) run.error = clip(outcome.error, AGENT_RESULT_PREVIEW);
  if (outcome.reason !== undefined) run.endReason = outcome.reason;
  notify();
  return run;
}

export function getAgentRun(id: string): AgentRun | null {
  return runs.get(id) ?? null;
}

/** 按 id 前缀匹配（用户输入短 id 用），唯一命中才返回 */
export function findAgentRunByPrefix(prefix: string): AgentRun | null {
  const matches = listAgentRuns().filter((r) => r.id.startsWith(prefix));
  return matches.length === 1 ? matches[0] : null;
}

/** 汇总全部 agent 的用量与数量（footer / /agents 用） */
export function aggregateAgentUsage(): {
  usage: AgentUsage;
  count: number;
  running: number;
} {
  const usage = emptyAgentUsage();
  let running = 0;
  for (const run of runs.values()) {
    if (run.status === "running") running += 1;
    if (!run.usage) continue;
    usage.input += run.usage.input;
    usage.output += run.usage.output;
    usage.cacheRead += run.usage.cacheRead;
    usage.cacheWrite += run.usage.cacheWrite;
    usage.cost += run.usage.cost;
  }
  return { usage, count: runs.size, running };
}

/** 测试隔离：清空注册表 */
export function clearAgentRuns(): void {
  runs.clear();
  lastTextNotifyAt = 0;
  notify();
}