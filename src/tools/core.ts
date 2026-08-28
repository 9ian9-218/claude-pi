/**
 * core.ts — Tool 抽象（工具值对象，从 tool.ts 拆出）
 * 纯数据 + run；行为在领域 pack 与 ToolRuntime。
 */
import type { OpenaiTool } from "../schema-strict.ts";
export type ExecuteFn = (args: Record<string, unknown>) => unknown | Promise<unknown>;

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

  run(args: Record<string, unknown>): unknown {
    return this.execute(args);
  }
}

export function buildTool(init: ConstructorParameters<typeof Tool>[0]): Tool {
  return new Tool(init);
}

// ── 路径校验 ──────────────────────────────────────────────────────────────
// ── 注册表与对外 API ──────────────────────────────────────────────────────

