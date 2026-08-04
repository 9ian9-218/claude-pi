/**
 * app.ts — TUI 宿主（pi-tui）
 *
 * 布局：顶部 Markdown 滚动区 + 底部输入行 + 状态行。
 * 事件流：Input 提交 → 斜杠命令或 onQuery；流式输出经 appendStream 进滚动区。
 */
import {
  TUI,
  Container,
  Input,
  Text,
  SelectList,
  type Terminal,
  type SelectItem,
  type Component,
} from "@earendil-works/pi-tui";
import { Scrollback } from "./scrollback.ts";
import { getSlashCommand } from "../commands.ts";
import type { SwarmPermissionRequest, PermissionResolution } from "../permission-sync.ts";

export interface TuiAppOptions {
  /** 测试注入 FakeTerminal；生产传 ProcessTerminal */
  terminal: Terminal;
  onQuery: (query: string) => Promise<void> | void;
  onNewSession?: () => void;
  /** 会话命令处理（15b：/tree /fork /clone /resume /name /session） */
  onSessionCommand?: (name: string, rest: string, app: TuiApp) => Promise<void> | void;
  /** 扩展重载（16：/reload） */
  onReload?: () => void;
  statusText?: () => string;
  initialText?: string;
}

/** AGENT_COLORS → ANSI 颜色码（10 的队友配色） */
function colorCode(color: string): number {
  const map: Record<string, number> = {
    blue: 34,
    green: 32,
    yellow: 33,
    purple: 35,
    orange: 33,
    pink: 35,
    cyan: 36,
    red: 31,
  };
  return map[color] ?? 32;
}

/** 拦截 resize 回调：先更新布局再转发给 TUI */
class ResizeAwareTerminal implements Terminal {
  private inner: Terminal;
  private onResize: () => void;

  constructor(inner: Terminal, onResize: () => void) {
    this.inner = inner;
    this.onResize = onResize;
  }

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.inner.start(onInput, () => {
      this.onResize();
      onResize();
    });
  }
  stop(): void {
    this.inner.stop();
  }
  async drainInput(maxMs?: number, idleMs?: number): Promise<void> {
    return this.inner.drainInput(maxMs, idleMs);
  }
  write(data: string): void {
    this.inner.write(data);
  }
  get columns(): number {
    return this.inner.columns;
  }
  get rows(): number {
    return this.inner.rows;
  }
  get kittyProtocolActive(): boolean {
    return this.inner.kittyProtocolActive;
  }
  moveBy(lines: number): void {
    this.inner.moveBy(lines);
  }
  hideCursor(): void {
    this.inner.hideCursor();
  }
  showCursor(): void {
    this.inner.showCursor();
  }
  clearLine(): void {
    this.inner.clearLine();
  }
  clearFromCursor(): void {
    this.inner.clearFromCursor();
  }
  clearScreen(): void {
    this.inner.clearScreen();
  }
  setTitle(title: string): void {
    this.inner.setTitle(title);
  }
  setProgress(active: boolean): void {
    this.inner.setProgress(active);
  }
}

export class TuiApp {
  readonly tui: TUI;
  readonly scrollback: Scrollback;
  readonly input: Input;
  private readonly onQuery: (q: string) => Promise<void> | void;
  private readonly onNewSession?: () => void;
  private readonly onSessionCommand?: (name: string, rest: string, app: TuiApp) => Promise<void> | void;
  private readonly onReload?: () => void;
  private readonly statusTextFn?: () => string;
  private readonly statusLine = new Text("", 1, 0);
  private readonly root = new Container();
  private busy = false;
  private running = true;

  constructor(options: TuiAppOptions) {
    this.onQuery = options.onQuery;
    this.onNewSession = options.onNewSession;
    this.onSessionCommand = options.onSessionCommand;
    this.onReload = options.onReload;
    this.statusTextFn = options.statusText;
    this.scrollback = new Scrollback(options.initialText ?? "");
    this.input = new Input();
    this.statusLine.setText(`\x1b[90mclaude-pi\x1b[0m`);

    const resizeAware = new ResizeAwareTerminal(options.terminal, () => this.layout());
    this.tui = new TUI(resizeAware);
    this.tui.addChild(this.root);
    this.root.addChild(this.scrollback);
    this.root.addChild(this.input);
    this.root.addChild(this.statusLine);

    this.input.onSubmit = (value) => {
      void this.handleSubmit(value);
    };
    this.input.onEscape = () => {
      this.running = false;
    };

    this.layout();
    this.tui.setFocus(this.input);
  }

  start(): void {
    this.tui.start();
  }

  stop(): void {
    this.tui.stop();
  }

  isRunning(): boolean {
    return this.running;
  }

  /** 流式输出追加到滚动区 */
  appendStream(text: string): void {
    this.scrollback.append(text);
    this.tui.requestRender();
  }

  /** 追加完整消息（user/assistant/tool 结果）；队友消息按 color 属性染色，后台通知绿色 */
  appendMessage(role: string, content: string): void {
    let rendered = content;
    if (content.includes("<teammate-message")) {
      const colorMatch = content.match(/color=\"([^\"]+)\"/);
      const color = colorMatch?.[1] ?? "green";
      rendered = `\x1b[${colorCode(color)}m${content}\x1b[0m`;
    } else if (content.includes("<task_notification>")) {
      rendered = `\x1b[32m${content}\x1b[0m`;
    }
    const label =
      role === "user"
        ? "\x1b[1;36mUser >\x1b[0m "
        : role === "assistant"
          ? "\x1b[1;32mModel >\x1b[0m "
          : `\x1b[1;33m${role} >\x1b[0m `;
    this.scrollback.append(`\n${label}${rendered}\n`);
    this.tui.requestRender();
  }

  private layout(): void {
    const rows = this.tui.terminal.rows;
    this.scrollback.setViewportHeight(Math.max(3, rows - 3));
  }

  private updateStatus(): void {
    const extra = this.statusTextFn ? ` | ${this.statusTextFn()}` : "";
    this.statusLine.setText(`\x1b[90mclaude-pi${extra}\x1b[0m`);
    this.tui.requestRender();
  }

  private async handleSubmit(value: string): Promise<void> {
    if (this.busy) return;
    const trimmed = value.trim();
    this.input.setValue("");
    if (trimmed.startsWith("/")) {
      await this.handleCommand(trimmed);
      return;
    }
    if (!trimmed) return;
    this.busy = true;
    this.updateStatus();
    this.appendMessage("user", trimmed);
    try {
      await this.onQuery(trimmed);
    } finally {
      this.busy = false;
      this.updateStatus();
      this.tui.setFocus(this.input);
    }
  }

  /** 权限确认弹窗（15a）：overlay SelectList，允许/拒绝/始终允许 */
  askPermission(
    request: SwarmPermissionRequest,
    label: string,
  ): Promise<PermissionResolution> {
    return new Promise((resolve) => {
      const items: SelectItem[] = [
        {
          value: "allow",
          label: "允许",
          description: `允许 ${request.toolName}`,
        },
        {
          value: "deny",
          label: "拒绝",
          description: "拒绝本次调用",
        },
      ];
      const list = new SelectList(items, 5, {
        selectedPrefix: (t) => `\x1b[36m▸ ${t}\x1b[0m`,
        selectedText: (t) => `\x1b[1m${t}\x1b[0m`,
        description: (t) => `\x1b[90m${t}\x1b[0m`,
        scrollInfo: (t) => `\x1b[90m${t}\x1b[0m`,
        noMatch: (t) => `\x1b[90m${t}\x1b[0m`,
      });
      const overlay = new Container();
      overlay.addChild(
        new Text(
          `\x1b[33m⚠  Permission request from ${label}\x1b[0m\n` +
            `   Tool: ${request.toolName}\n` +
            `   Reason: ${request.description}\n` +
            `   Input: ${JSON.stringify(request.input).slice(0, 200)}\n`,
          1,
          1,
        ),
      );
      overlay.addChild(list);
      const handle = this.tui.showOverlay(overlay, { width: "70%", anchor: "center" });
      // Container 无 handleInput——用全局输入监听把按键转发给 SelectList
      const removeListener = this.tui.addInputListener((data) => {
        list.handleInput(data);
        return { consume: true };
      });
      const finish = (resolution: PermissionResolution) => {
        removeListener();
        handle.hide();
        this.tui.setFocus(this.input);
        resolve(resolution);
      };
      list.onSelect = (item) => {
        if (item.value === "allow") {
          finish({ decision: "approved", resolvedBy: "leader" });
        } else {
          finish({
            decision: "rejected",
            resolvedBy: "leader",
            feedback: "Permission denied by user",
          });
        }
      };
      list.onCancel = () => {
        finish({
          decision: "rejected",
          resolvedBy: "leader",
          feedback: "Permission denied by user",
        });
      };
    });
  }

  private async handleCommand(cmd: string): Promise<void> {
    const [name] = cmd.slice(1).split(/\s+/);
    switch (name) {
      case "new":
      case "n":
        this.onNewSession?.();
        this.scrollback.clear();
        this.appendMessage("system", "新会话已开始。输入 /help 查看命令。");
        break;
      case "help":
        this.appendMessage(
          "system",
          ["/new 开新会话", "/help 显示帮助", "/quit 退出", "/status 显示状态", "Ctrl+C / Esc 退出"].join("\n"),
        );
        break;
      case "quit":
      case "exit":
      case "q":
        this.running = false;
        this.tui.stop();
        break;
      case "status":
        this.appendMessage("system", this.statusTextFn?.() ?? "no status");
        break;
      case "reload":
        this.onReload?.();
        this.appendMessage("system", "扩展已重载。");
        break;
      default: {
        // 扩展命令注册表（16）
        const ext = getSlashCommand(name);
        if (ext) {
          try {
            const result = await ext.handler(cmd.slice(1 + name.length).trim());
            this.appendMessage("system", String(result));
          } catch (e) {
            this.appendMessage("system", `扩展命令错误：${String((e as Error).message)}`);
          }
          break;
        }
        if (this.onSessionCommand) {
          await this.onSessionCommand(name, cmd.slice(1 + name.length).trim(), this);
          break;
        }
        this.appendMessage("system", `未知命令：/${name}（/help 查看）`);
      }
    }
    this.tui.setFocus(this.input);
  }

  /** 通用选择器（15b：树节点/fork 目标/会话列表），返回选中项或 null */
  showSelector(items: SelectItem[], title: string): Promise<SelectItem | null> {
    return new Promise((resolve) => {
      const list = new SelectList(items, 8, {
        selectedPrefix: (t) => `\x1b[36m▸ ${t}\x1b[0m`,
        selectedText: (t) => `\x1b[1m${t}\x1b[0m`,
        description: (t) => `\x1b[90m${t}\x1b[0m`,
        scrollInfo: (t) => `\x1b[90m${t}\x1b[0m`,
        noMatch: (t) => `\x1b[90m${t}\x1b[0m`,
      });
      const overlay = new Container();
      overlay.addChild(new Text(`\x1b[36m${title}\x1b[0m\n`, 1, 1));
      overlay.addChild(list);
      const handle = this.tui.showOverlay(overlay, { width: "70%", anchor: "center" });
      const removeListener = this.tui.addInputListener((data) => {
        list.handleInput(data);
        return { consume: true };
      });
      const finish = (item: SelectItem | null) => {
        removeListener();
        handle.hide();
        this.tui.setFocus(this.input);
        resolve(item);
      };
      list.onSelect = (item) => finish(item);
      list.onCancel = () => finish(null);
    });
  }

  /** 清空滚动区并显示新内容（会话切换后） */
  refreshScrollback(text: string): void {
    this.scrollback.setText(text);
    this.tui.requestRender();
  }

  /** 输入对话框（17 ctx.ui.input）：overlay + Input 组件 */
  showInputDialog(message: string): Promise<string | null> {
    return new Promise((resolve) => {
      const input = new Input();
      const overlay = new Container();
      overlay.addChild(new Text(`\x1b[36m${message}\x1b[0m\n`, 1, 1));
      overlay.addChild(input);
      const handle = this.tui.showOverlay(overlay, { width: "70%", anchor: "center" });
      const removeListener = this.tui.addInputListener((data) => {
        input.handleInput(data);
        return { consume: true };
      });
      const finish = (value: string | null) => {
        removeListener();
        handle.hide();
        this.tui.setFocus(this.input);
        resolve(value);
      };
      input.onSubmit = (value) => finish(value);
      input.onEscape = () => finish(null);
    });
  }

  /** 挂载扩展自定义组件（17 ctx.ui.custom） */
  mountCustomComponent(component: Component): void {
    const handle = this.tui.showOverlay(component, { width: "70%", anchor: "center" });
    // 自定义组件负责自身交互；Esc 关闭
    const removeListener = this.tui.addInputListener((data) => {
      if (component.handleInput) {
        component.handleInput(data);
      }
      return { consume: true };
    });
    const close = () => {
      removeListener();
      handle.hide();
      this.tui.setFocus(this.input);
    };
    // Esc 关闭
    const esc = this.tui.addInputListener((data) => {
      if (data === "\x1b") {
        close();
        esc();
      }
      return { consume: false };
    });
  }
}
