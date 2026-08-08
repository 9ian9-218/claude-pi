/**
 * turn-controller.ts — 回合生命周期（架构 B）
 *
 * 从 TuiApp 拆出：busy 状态 + AbortController 中断链路（ADR-0008）。
 * 深接口：beginTurn/getSignal/endTurn/interrupt，TuiApp 不再直接持有
 * AbortController 与 busy 标志。
 */
export class TurnController {
  private controller: AbortController | null = null;
  private busy = false;

  /** 开启可中断回合（handleSubmit 调用）；返回 AbortSignal（Esc 中止） */
  beginTurn(): AbortSignal {
    this.controller?.abort();
    this.controller = new AbortController();
    return this.controller.signal;
  }

  /** 回合结束：清理中断控制器 */
  endTurn(): void {
    this.controller = null;
  }

  /** 当前回合的 AbortSignal（onQuery 内取用；空闲时 null） */
  getSignal(): AbortSignal | null {
    return this.controller?.signal ?? null;
  }

  /** busy 状态（输入提交期间；Esc 仅在 busy 时中断） */
  isBusy(): boolean {
    return this.busy;
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
  }

  /** Esc 中断：仅 busy 时 abort，返回是否发生了中断 */
  interrupt(): boolean {
    if (!this.busy) return false;
    this.controller?.abort();
    return true;
  }
}
