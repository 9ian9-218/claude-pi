/**
 * loop-options.ts — Agent Loop 运行时选项（对齐 src/loop_options.py）
 *
 * 解耦身份（主/子/队友）、I/O 与特性开关。
 */
import type { UiEventSink } from "./ui-events.ts";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
export class LoopOptions {
  readonly preserveSystem: boolean;
  readonly injectLeadNotifications: boolean;
  readonly injectBackgroundNotifications: boolean;
  readonly enableMemory: boolean;
  readonly enableBackground: boolean;
  readonly quietOutput: boolean;
  readonly exitOnFinalContent: boolean;
  readonly skipMemoryStopHook: boolean;
  /** UI 事件通道（ADR-0008，架构 C）：单一广播出口（stream/tool/turnEnd） */
  readonly uiEvents?: UiEventSink;
  /** 思考强度（/thinking、Shift+Tab 设置；off 不发 thinking 参数） */
  readonly thinkingLevel?: ModelThinkingLevel;
  /** 用户中断信号（Esc 中止当前回合；不传则不可中断） */
  readonly signal?: AbortSignal;

  constructor(init: Partial<LoopOptions> = {}) {
    this.preserveSystem = init.preserveSystem ?? false;
    this.injectLeadNotifications = init.injectLeadNotifications ?? true;
    this.injectBackgroundNotifications = init.injectBackgroundNotifications ?? true;
    this.enableMemory = init.enableMemory ?? true;
    this.enableBackground = init.enableBackground ?? true;
    this.quietOutput = init.quietOutput ?? false;
    this.exitOnFinalContent = init.exitOnFinalContent ?? false;
    this.skipMemoryStopHook = init.skipMemoryStopHook ?? false;
    this.uiEvents = init.uiEvents;
    this.thinkingLevel = init.thinkingLevel;
    this.signal = init.signal;
  }

  static lead(): LoopOptions {
    return new LoopOptions();
  }

  static subagent(): LoopOptions {
    return new LoopOptions({
      injectLeadNotifications: false,
      injectBackgroundNotifications: false,
      enableMemory: false,
      enableBackground: false,
      quietOutput: true,
      exitOnFinalContent: true,
      skipMemoryStopHook: true,
    });
  }

  static teammate(): LoopOptions {
    return new LoopOptions({
      preserveSystem: true,
      injectLeadNotifications: false,
      injectBackgroundNotifications: true,
      enableMemory: false,
      enableBackground: true,
      quietOutput: true,
      exitOnFinalContent: true,
      skipMemoryStopHook: true,
    });
  }

  static fromLegacyIsSubagent(isSubagent: boolean): LoopOptions {
    return isSubagent ? LoopOptions.subagent() : LoopOptions.lead();
  }
}
