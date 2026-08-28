/**
 * loop-options.ts — Agent Loop 运行时选项
 *
 * 身份策略来自 AgentProfile；本模块合并 Profile 派生旗标与 Turn 级选项
 * （uiEvents / signal / thinkingLevel）。
 */
import type { UiEventSink } from "./ui-events.ts";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { AgentProfile, type AgentProfile as Profile } from "./agent-profile.ts";
import type { AgentRole } from "./teammates/context.ts";

export class LoopOptions {
  /** 身份角色（lead / subagent / teammate） */
  readonly role: AgentRole;
  readonly preserveSystem: boolean;
  readonly injectLeadNotifications: boolean;
  readonly injectBackgroundNotifications: boolean;
  readonly enableMemory: boolean;
  readonly enableBackground: boolean;
  readonly quietOutput: boolean;
  readonly exitOnFinalContent: boolean;
  readonly skipMemoryStopHook: boolean;
  /** 子代理工具面与系统提示（仅 subagent） */
  readonly useSubagentToolFace: boolean;
  readonly useSubagentPrompt: boolean;
  /** UI 事件通道（ADR-0008）：Turn 级 */
  readonly uiEvents?: UiEventSink;
  /** 思考强度：Turn 级 */
  readonly thinkingLevel?: ModelThinkingLevel;
  /** 用户中断信号：Turn 级 */
  readonly signal?: AbortSignal;

  constructor(init: Partial<LoopOptions> & { role?: AgentRole } = {}) {
    const role = init.role ?? "lead";
    const profile =
      role === "subagent"
        ? AgentProfile.subagent()
        : role === "teammate"
          ? AgentProfile.teammate()
          : AgentProfile.lead();
    this.role = role;
    this.preserveSystem = init.preserveSystem ?? profile.preserveSystem;
    this.injectLeadNotifications =
      init.injectLeadNotifications ?? profile.injectLeadNotifications;
    this.injectBackgroundNotifications =
      init.injectBackgroundNotifications ?? profile.injectBackgroundNotifications;
    this.enableMemory = init.enableMemory ?? profile.enableMemory;
    this.enableBackground = init.enableBackground ?? profile.enableBackground;
    this.quietOutput = init.quietOutput ?? profile.quietOutput;
    this.exitOnFinalContent = init.exitOnFinalContent ?? profile.exitOnFinalContent;
    this.skipMemoryStopHook = init.skipMemoryStopHook ?? profile.skipMemoryStopHook;
    // role 是唯一身份源：工具面/提示面由 role 派生，禁止覆盖
    this.useSubagentToolFace = role === "subagent";
    this.useSubagentPrompt = role === "subagent";
    this.uiEvents = init.uiEvents;
    this.thinkingLevel = init.thinkingLevel;
    this.signal = init.signal;
  }

  /** 从 AgentProfile + Turn 级覆盖构造 */
  static fromProfile(
    profile: Profile,
    turn: Partial<Pick<LoopOptions, "uiEvents" | "thinkingLevel" | "signal" | "quietOutput">> = {},
  ): LoopOptions {
    return new LoopOptions({
      role: profile.role,
      preserveSystem: profile.preserveSystem,
      injectLeadNotifications: profile.injectLeadNotifications,
      injectBackgroundNotifications: profile.injectBackgroundNotifications,
      enableMemory: profile.enableMemory,
      enableBackground: profile.enableBackground,
      quietOutput: turn.quietOutput ?? profile.quietOutput,
      exitOnFinalContent: profile.exitOnFinalContent,
      skipMemoryStopHook: profile.skipMemoryStopHook,
      useSubagentToolFace: profile.useSubagentToolFace,
      useSubagentPrompt: profile.useSubagentPrompt,
      uiEvents: turn.uiEvents,
      thinkingLevel: turn.thinkingLevel,
      signal: turn.signal,
    });
  }

  static lead(
    turn: Partial<Pick<LoopOptions, "uiEvents" | "thinkingLevel" | "signal" | "quietOutput">> = {},
  ): LoopOptions {
    return LoopOptions.fromProfile(AgentProfile.lead(), turn);
  }

  static subagent(
    turn: Partial<Pick<LoopOptions, "uiEvents" | "thinkingLevel" | "signal" | "quietOutput">> = {},
  ): LoopOptions {
    return LoopOptions.fromProfile(AgentProfile.subagent(), turn);
  }

  static teammate(
    turn: Partial<Pick<LoopOptions, "uiEvents" | "thinkingLevel" | "signal" | "quietOutput">> = {},
  ): LoopOptions {
    return LoopOptions.fromProfile(AgentProfile.teammate(), turn);
  }

  /** @deprecated 使用 LoopOptions.subagent() / lead()；保留兼容旧 isSubagent 布尔通道 */
  static fromLegacyIsSubagent(isSubagent: boolean): LoopOptions {
    return isSubagent ? LoopOptions.subagent() : LoopOptions.lead();
  }

  get isSubagentRole(): boolean {
    return this.role === "subagent";
  }

  get isTeammateRole(): boolean {
    return this.role === "teammate";
  }

  get isLeadRole(): boolean {
    return this.role === "lead";
  }
}
