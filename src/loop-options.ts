/**
 * loop-options.ts — Agent Loop 运行时选项（对齐 src/loop_options.py）
 *
 * 解耦身份（主/子/队友）、I/O 与特性开关。
 */
import type { ToolUiEvent, TurnEndEvent, UiStreamDelta } from "./ui-events.ts";
export class LoopOptions {
  readonly preserveSystem: boolean;
  readonly injectLeadNotifications: boolean;
  readonly injectBackgroundNotifications: boolean;
  readonly enableMemory: boolean;
  readonly enableBackground: boolean;
  readonly quietOutput: boolean;
  readonly exitOnFinalContent: boolean;
  readonly skipMemoryStopHook: boolean;
  /** UI 事件通道（ADR-0008）：结构化流式增量（text/thinking） */
  readonly onStream?: (delta: UiStreamDelta) => void;
  /** UI 事件通道：工具执行块事件（start/result） */
  readonly onToolEvent?: (event: ToolUiEvent) => void;
  /** UI 事件通道：回合结束状态（stopReason/errorMessage） */
  readonly onTurnEnd?: (event: TurnEndEvent) => void;
  /** UI 事件通道：用户中断信号（Esc 中止当前回合；不传则不可中断） */
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
    this.onStream = init.onStream;
    this.onToolEvent = init.onToolEvent;
    this.onTurnEnd = init.onTurnEnd;
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
