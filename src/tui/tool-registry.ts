/**
 * tool-registry.ts — 工具执行块注册表（架构 B）
 *
 * 从 TuiApp 拆出：工具块 id → 组件映射 + 折叠偏好（Ctrl+O）。
 * 组件通过注入的 addChild 挂到聊天区（依赖注入，可独立测试）。
 */
import type { Component } from "@earendil-works/pi-tui";
import type { ToolUiEvent } from "../ui-events.ts";
import { ToolExecutionComponent } from "./messages/tool-execution.ts";

export class ToolBlockRegistry {
  private readonly map = new Map<string, ToolExecutionComponent>();
  private expanded = false;
  private readonly addChild: (c: Component) => void;

  constructor(addChild: (c: Component) => void) {
    this.addChild = addChild;
  }

  /** 工具事件（04）：start 创建灰底块，result 更新绿/红底 */
  handleEvent(event: ToolUiEvent): void {
    let component = this.map.get(event.id);
    if (!component) {
      component = new ToolExecutionComponent(event.name, event.id, event.args);
      component.setExpanded(this.expanded);
      this.map.set(event.id, component);
      this.addChild(component);
    }
    if (event.phase === "result") {
      component.updateResult(event.result ?? "", event.isError ?? false);
    }
  }

  /** Ctrl+O：切换全部工具块展开/折叠（对齐 pi app.tools.expand） */
  toggleExpansion(): void {
    this.expanded = !this.expanded;
    for (const component of this.map.values()) {
      component.setExpanded(this.expanded);
    }
  }

  isExpanded(): boolean {
    return this.expanded;
  }

  size(): number {
    return this.map.size;
  }
}
