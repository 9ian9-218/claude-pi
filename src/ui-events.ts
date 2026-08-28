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

/** 诊断/状态通知（架构 C 扩展）：核心机制的状态行（inject/compact/retry/escalate 等）。
 * 有 UI 订阅者时走通道渲染，无订阅者时由 emitNoticeOrLog 回退 console（REPL/对拍不变）。 */
export interface NoticeUiEvent {
  /** 单行状态文本（含 ANSI 色码，与原有 console 输出一致） */
  text: string;
  /** inject：队友消息/后台任务注入；status：其余诊断 */
  kind?: "status" | "inject";
}

/** 回合结束事件：stopReason 与错误信息（pi-ai 语义：stop/length/toolUse/error/aborted） */
export interface TurnEndEvent {
  stopReason?: string;
  errorMessage?: string;
  /** 缓存诊断：本回合相对上轮应命中却重计费（对齐 pi cache-stats） */
  cacheMiss?: {
    missedTokens: number;
    missedCost: number;
    idleMs: number;
  };
}

/** 事件类型 → 载荷映射（架构 C：UiEventSink 的单一传播面） */
export interface UiEventMap {
  stream: UiStreamDelta;
  tool: ToolUiEvent;
  turnEnd: TurnEndEvent;
  notice: NoticeUiEvent;
}

type UiEventKey = keyof UiEventMap;
type UiEventHandler<K extends UiEventKey> = (event: UiEventMap[K]) => void;

/**
 * UiEventSink（架构 C）— 核心机制向 UI 广播事件的单一出口。
 *
 * agent-loop / error-recovery / client 只 emit；TUI 只订阅。新增事件只
 * 动 UiEventMap 一处（替代 onStream/onToolEvent/onTurnEnd 逐层透传）。
 * 无监听器时 emit 为 no-op（ADR-0008：不传 sink = 无 UI，行为不变）。
 */
export class UiEventSink {
  private readonly listeners = new Map<UiEventKey, Set<UiEventHandler<UiEventKey>>>();

  /** 订阅事件；返回取消订阅函数 */
  on<K extends UiEventKey>(type: K, handler: UiEventHandler<K>): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(handler as UiEventHandler<UiEventKey>);
    return () => {
      set!.delete(handler as UiEventHandler<UiEventKey>);
    };
  }

  /** 广播事件（无订阅者时 no-op） */
  emit<K extends UiEventKey>(type: K, event: UiEventMap[K]): void {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const handler of set) {
      handler(event as UiEventMap[UiEventKey]);
    }
  }

  listenerCount(type: UiEventKey): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

/**
 * 诊断打印统一出口：有 UI 订阅者走 notice 通道（TUI 聊天渲染），
 * 无订阅者回退 console.log（REPL / -p / --mode json 行为字节不变）。
 */
export function emitNoticeOrLog(
  sink: UiEventSink | undefined,
  text: string,
  kind: NoticeUiEvent["kind"] = "status",
): void {
  if (sink && sink.listenerCount("notice") > 0) {
    sink.emit("notice", { kind, text });
  } else {
    console.log(text);
  }
}

