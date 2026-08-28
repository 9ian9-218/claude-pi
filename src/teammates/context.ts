/** Agent 身份上下文（对齐 teammates/context.py，AsyncLocalStorage 替代线程本地） */
import { AsyncLocalStorage } from "node:async_hooks";
import { TEAM_LEAD_NAME } from "./constants.ts";

export type AgentRole = "lead" | "teammate" | "subagent";

export interface AgentContext {
  teamName: string | null;
  agentName: string;
  agentId: string | null;
  color: string | null;
  role: AgentRole;
  agentType: string;
}

export function createAgentContext(init: Partial<AgentContext> = {}): AgentContext {
  return {
    teamName: init.teamName ?? null,
    agentName: init.agentName ?? TEAM_LEAD_NAME,
    agentId: init.agentId ?? null,
    color: init.color ?? null,
    role: init.role ?? "lead",
    agentType: init.agentType ?? "general-purpose",
  };
}

export function isLead(ctx: AgentContext): boolean {
  return ctx.role === "lead";
}

export function isTeammate(ctx: AgentContext): boolean {
  return ctx.role === "teammate";
}

export function isSubagent(ctx: AgentContext): boolean {
  return ctx.role === "subagent";
}

export function isWorker(ctx: AgentContext): boolean {
  return ctx.role === "teammate" || ctx.role === "subagent";
}

const ctxStore = new AsyncLocalStorage<AgentContext>();

/** 进程级 Lead 默认上下文（Python 版全局 agent_context 语义）：
 * 无 ALS store（Lead 主线程/非 teammate 路径）时返回它；
 * create_team / initLeadTeam 更新它，回合间与测试间持久。 */
let leadContext: AgentContext | null = null;

export function getAgentContext(): AgentContext {
  return ctxStore.getStore() ?? leadContext ?? createAgentContext();
}

/** 设置进程级 Lead 上下文（无 store 的所有读取者可见；worker 仍被 run() 隔离） */
export function setAgentContext(ctx: AgentContext): void {
  leadContext = ctx;
}

/** 测试/进程清理：清除 Lead 默认上下文 */
export function resetAgentContext(): void {
  leadContext = null;
}

export function runWithAgentContext<T>(ctx: AgentContext, fn: () => T): T {
  return ctxStore.run(ctx, fn);
}

/** 在给定身份下运行 fn，结束后恢复原身份（对齐 agent_context 上下文管理器） */
export function withAgentContext<T>(ctx: AgentContext, fn: () => T): T {
  const prev = getAgentContext();
  return ctxStore.run(ctx, () => {
    try {
      return fn();
    } finally {
      void prev;
    }
  });
}
