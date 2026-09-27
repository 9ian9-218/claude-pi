/**
 * agent-profile.ts — Agent 身份档案（Lead / Subagent / Teammate / Pipeline 专职角色）
 *
 * 对齐 Claude Code 语义并支持固定协同流水线：
 * - Lead：用户交互面，完整工具面，邮箱注入 + Memory + 后台任务
 * - Subagent：进程内一次性委派，受限工具面，无 Memory/无队友孵化，摘要交回父 loop
 * - Teammate：团队内异步 worker，独立 loop + 邮箱，权限经邮箱冒泡 Lead
 * - 专职 Pipeline 角色：
 *   - scout: 快速定位代码位置与依赖，提取最小上下文包（只读）
 *   - planner: 架构推演、细化步骤与验收断言（只读）
 *   - worker: 专注落实代码改动并产出变更报告（可写）
 *   - reviewer: 静态白盒审查代码质量、规范与安全（只读）
 *   - verifier: 动态黑盒/白盒执行构建与测试套件（受控测试，严禁改业务代码）
 */
import {
  type AgentContext,
  type AgentRole,
  isPipelineRole,
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
  if (role === "subagent" || isPipelineRole(role)) {
    return {
      role,
      teamName: null,
      agentName: role,
      agentId: null,
      color: null,
      agentType: role,
      preserveSystem: false,
      injectLeadNotifications: false,
      injectBackgroundNotifications: false,
      enableMemory: false,
      enableBackground: role === "worker",
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
    // role 是唯一身份源：工具面/提示面由 role 派生
    useSubagentToolFace: role !== "lead" && role !== "teammate",
    useSubagentPrompt: role !== "lead" && role !== "teammate",
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
  scout(init: Partial<AgentProfile> = {}): AgentProfile {
    return base("scout", init);
  },
  planner(init: Partial<AgentProfile> = {}): AgentProfile {
    return base("planner", init);
  },
  worker(init: Partial<AgentProfile> = {}): AgentProfile {
    return base("worker", init);
  },
  reviewer(init: Partial<AgentProfile> = {}): AgentProfile {
    return base("reviewer", init);
  },
  verifier(init: Partial<AgentProfile> = {}): AgentProfile {
    return base("verifier", init);
  },
  fromRole(role: AgentRole, init: Partial<AgentProfile> = {}): AgentProfile {
    return base(role, init);
  },
  fromContext(ctx: AgentContext): AgentProfile {
    return base(ctx.role, {
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