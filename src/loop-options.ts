/**
 * loop-options.ts — Agent Loop 运行时选项（对齐 src/loop_options.py）
 *
 * 解耦身份（主/子/队友）、I/O 与特性开关。
 */
export class LoopOptions {
  readonly preserveSystem: boolean;
  readonly injectLeadNotifications: boolean;
  readonly injectBackgroundNotifications: boolean;
  readonly enableMemory: boolean;
  readonly enableBackground: boolean;
  readonly quietOutput: boolean;
  readonly exitOnFinalContent: boolean;
  readonly skipMemoryStopHook: boolean;

  constructor(init: Partial<LoopOptions> = {}) {
    this.preserveSystem = init.preserveSystem ?? false;
    this.injectLeadNotifications = init.injectLeadNotifications ?? true;
    this.injectBackgroundNotifications = init.injectBackgroundNotifications ?? true;
    this.enableMemory = init.enableMemory ?? true;
    this.enableBackground = init.enableBackground ?? true;
    this.quietOutput = init.quietOutput ?? false;
    this.exitOnFinalContent = init.exitOnFinalContent ?? false;
    this.skipMemoryStopHook = init.skipMemoryStopHook ?? false;
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
