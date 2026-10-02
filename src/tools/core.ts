/**
 * core.ts — Tool 抽象（工具值对象，从 tool.ts 拆出）
 * 纯数据 + run；行为在领域 pack 与 ToolRuntime。
 */
import type { OpenaiTool } from "../schema-strict.ts";
import type { SessionManager } from "../session-manager.ts";
import type { UiEventSink } from "../ui-events.ts";

/**
 * 工具执行上下文：由 ToolRuntime 从 agent-loop 注入。
 * - session：当前 loop 的会话（子 agent 委托据此登记血缘与子会话）
 * - uiEvents：当前 loop 的 UI 事件通道（工具可把诊断经 notice 通道送到 TUI）
 */
export interface ToolExecContext {
  session?: SessionManager | null;
  uiEvents?: UiEventSink;
  signal?: AbortSignal;
  allowBackground?: boolean;
}

export type ExecuteFn = (
  args: Record<string, unknown>,
  ctx?: ToolExecContext,
) => unknown | Promise<unknown>;

/** Tool 核心抽象（对齐 Python frozen dataclass） */
export class Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly execute: ExecuteFn;
  readonly isReadOnly: boolean;

  constructor(init: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    execute: ExecuteFn;
    isReadOnly?: boolean;
  }) {
    this.name = init.name;
    this.description = init.description;
    this.parameters = init.parameters;
    this.execute = init.execute;
    this.isReadOnly = init.isReadOnly ?? false;
  }

  toOpenaiSchema(): OpenaiTool {
    return {
      type: "function",
      function: {
        name: this.name,
        description: this.description,
        parameters: this.parameters,
      },
    };
  }

  run(args: Record<string, unknown>, ctx?: ToolExecContext): unknown {
    return this.execute(args, ctx);
  }
}

export function buildTool(init: ConstructorParameters<typeof Tool>[0]): Tool {
  return new Tool(init);
}

// ── 路径校验 ──────────────────────────────────────────────────────────────
// ── 注册表与对外 API ──────────────────────────────────────────────────────
