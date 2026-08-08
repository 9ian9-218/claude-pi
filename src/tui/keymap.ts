/**
 * keymap.ts — 键位映射（架构 B）
 *
 * 从 TuiApp 拆出：键序列 → 动作的纯映射。深接口：bind/handle。
 * 动作的 busy/空闲语义由注册时的闭包决定，Keymap 自身不感知 UI 状态。
 */
export type KeyAction = () => void;

export class Keymap {
  private readonly bindings = new Map<string, KeyAction>();

  bind(key: string, action: KeyAction): void {
    this.bindings.set(key, action);
  }

  /** 处理输入；返回是否消费（有绑定且已执行） */
  handle(data: string): boolean {
    const action = this.bindings.get(data);
    if (!action) return false;
    action();
    return true;
  }
}
