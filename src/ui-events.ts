/**
 * ui-events.ts — UI 事件通道类型（ADR-0008）
 *
 * 核心机制（agent-loop / client / error-recovery）通过 LoopOptions 上的
 * 可选回调向 UI 广播事件；核心逻辑不感知 UI 的存在，不传回调时行为与
 * 无 UI 完全一致。
 */

/** 流式内容增量：text（正文）或 thinking（推理），供 TUI 分块渲染 */
export type UiStreamDelta =
  | { kind: "text"; delta: string }
  | { kind: "thinking"; delta: string };

/** 工具执行块事件：phase=start 在工具调用发起前，phase=result 在结果返回后 */
export interface ToolUiEvent {
  phase: "start" | "result";
  /** 工具名（如 bash / read） */
  name: string;
  /** 工具调用 id */
  id: string;
  /** 解析后的参数对象（JSON 解析失败时为 null） */
  args: unknown;
  /** result 阶段：工具返回的字符串结果 */
  result?: string;
  /** result 阶段：结果是否代表错误（hook 拦截 / 参数非法） */
  isError?: boolean;
}

/** 回合结束事件：stopReason 与错误信息（pi-ai 语义：stop/length/toolUse/error/aborted） */
export interface TurnEndEvent {
  stopReason?: string;
  errorMessage?: string;
}
