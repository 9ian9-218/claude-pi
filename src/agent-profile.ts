/**
 * agent-profile.ts — Agent 身份档案（Lead / Subagent / Teammate）
 *
 * 对齐 Claude Code 语义：
 * - Lead：用户交互面，完整工具面，邮箱注入 + Memory + 后台任务
 * - Subagent：进程内一次性委派，受限工具面，无 Memory/无队友孵化，摘要交回父 loop；
 *   权限同步冒泡给当前 Lead 上下文
 * - Teammate：团队内异步 worker，独立 loop + 邮箱，权限经邮箱冒泡 Lead
 *
 * Profile = 身份 + 派生 loop 策略。Turn 级选项（uiEvents/signal/thinkingLevel）不进 Profile。
 */
import {
  type AgentContext,
  type AgentRole,
  createAgentContext,
} from "./teammates/context.ts";
import { TEAM_LEAD_NAME } from "./teammates/constants.ts";

export type { AgentRole };

export interface AgentProfile {
  readonly role: AgentRole;
  readonly teamName: string | null;
  readonly agentName: string;
  readonly agentId: string | null;
  readonly color: string | null;
  readonly agentType: string;
  readonly preserveSystem: boolean;
  readonly injectLeadNotifications: boolean;
  readonly injectBackgroundNotifications: boolean;
  readonly enableMemory: boolean;
  readonly enableBackground: boolean;
  readonly quietOutput: boolean;
  readonly exitOnFinalContent: boolean;
  readonly skipMemoryStopHook: boolean;
  readonly useSubagentToolFace: boolean;
  readonly useSubagentPrompt: boolean;
}

function defaultsFor(role: AgentRole): AgentProfile {
  if (role === "subagent") {
    return {
      role: "subagent",
      teamName: null,
      agentName: "subagent",
      agentId: null,
      color: null,
      agentType: "general-purpose",
      preserveSystem: false,
      injectLeadNotifications: false,
      injectBackgroundNotifications: false,
      enableMemory: false,
      enableBackground: false,
      quietOutput: true,
      exitOnFinalContent: true,
      skipMemoryStopHook: true,
      useSubagentToolFace: true,
      useSubagentPrompt: true,
    };
  }
  if (role === "teammate") {
    return {
      role: "teammate",
      teamName: null,
      agentName: "teammate",
      agentId: null,
      color: null,
      agentType: "general-purpose",
      preserveSystem: true,
      injectLeadNotifications: false,
      injectBackgroundNotifications: true,
      enableMemory: false,
      enableBackground: true,
      quietOutput: true,
      exitOnFinalContent: true,
      skipMemoryStopHook: true,
      useSubagentToolFace: false,
      useSubagentPrompt: false,
    };
  }
  return {
    role: "lead",
    teamName: null,
    agentName: TEAM_LEAD_NAME,
    agentId: null,
    color: null,
    agentType: "general-purpose",
    preserveSystem: false,
    injectLeadNotifications: true,
    injectBackgroundNotifications: true,
    enableMemory: true,
    enableBackground: true,
    quietOutput: false,
    exitOnFinalContent: false,
    skipMemoryStopHook: false,
    useSubagentToolFace: false,
    useSubagentPrompt: false,
  };
}

function base(role: AgentRole, init: Partial<AgentProfile> = {}): AgentProfile {
  const d = defaultsFor(role);
  return {
    role,
    teamName: init.teamName ?? d.teamName,
    agentName: init.agentName ?? d.agentName,
    agentId: init.agentId ?? d.agentId,
    color: init.color ?? d.color,
    agentType: init.agentType ?? d.agentType,
    preserveSystem: init.preserveSystem ?? d.preserveSystem,
    injectLeadNotifications: init.injectLeadNotifications ?? d.injectLeadNotifications,
    injectBackgroundNotifications:
      init.injectBackgroundNotifications ?? d.injectBackgroundNotifications,
    enableMemory: init.enableMemory ?? d.enableMemory,
    enableBackground: init.enableBackground ?? d.enableBackground,
    quietOutput: init.quietOutput ?? d.quietOutput,
    exitOnFinalContent: init.exitOnFinalContent ?? d.exitOnFinalContent,
    skipMemoryStopHook: init.skipMemoryStopHook ?? d.skipMemoryStopHook,
    // role 是唯一身份源：工具面/提示面不可被 init 覆盖（防提示注入绕过）
    useSubagentToolFace: role === "subagent",
    useSubagentPrompt: role === "subagent",
  };
}

export const AgentProfile = {
  lead(init: Partial<AgentProfile> = {}): AgentProfile {
    return base("lead", init);
  },
  subagent(init: Partial<AgentProfile> = {}): AgentProfile {
    return base("subagent", init);
  },
  teammate(init: Partial<AgentProfile> = {}): AgentProfile {
    return base("teammate", init);
  },
  fromContext(ctx: AgentContext): AgentProfile {
    if (ctx.role === "subagent") {
      return AgentProfile.subagent({
        teamName: ctx.teamName,
        agentName: ctx.agentName,
        agentId: ctx.agentId,
        color: ctx.color,
        agentType: ctx.agentType,
      });
    }
    if (ctx.role === "teammate") {
      return AgentProfile.teammate({
        teamName: ctx.teamName,
        agentName: ctx.agentName,
        agentId: ctx.agentId,
        color: ctx.color,
        agentType: ctx.agentType,
      });
    }
    return AgentProfile.lead({
      teamName: ctx.teamName,
      agentName: ctx.agentName,
      agentId: ctx.agentId,
      color: ctx.color,
      agentType: ctx.agentType,
    });
  },
};

export function profileToContext(profile: AgentProfile): AgentContext {
  return createAgentContext({
    role: profile.role,
    teamName: profile.teamName,
    agentName: profile.agentName,
    agentId: profile.agentId,
    color: profile.color,
    agentType: profile.agentType,
  });
}
