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
  type Terminal,
} from "@earendil-works/pi-tui";
import { Scrollback } from "./scrollback.ts";

export interface TuiAppOptions {
  /** 测试注入 FakeTerminal；生产传 ProcessTerminal */
  terminal: Terminal;
  onQuery: (query: string) => Promise<void> | void;
  onNewSession?: () => void;
  statusText?: () => string;
  initialText?: string;
}

/** 拦截 resize 回调：先更新布局再转发给 TUI */
class ResizeAwareTerminal implements Terminal {
  constructor(
    private inner: Terminal,
    private onResize: () => void,
  ) {}

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
  private readonly statusTextFn?: () => string;
  private readonly statusLine = new Text("", 1, 0);
  private readonly root = new Container();
  private busy = false;
  private running = true;

  constructor(options: TuiAppOptions) {
    this.onQuery = options.onQuery;
    this.onNewSession = options.onNewSession;
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

  /** 追加完整消息（user/assistant/tool 结果） */
  appendMessage(role: string, content: string): void {
    const label =
      role === "user"
        ? "\x1b[1;36mUser >\x1b[0m "
        : role === "assistant"
          ? "\x1b[1;32mModel >\x1b[0m "
          : `\x1b[1;33m${role} >\x1b[0m `;
    this.scrollback.append(`\n${label}${content}\n`);
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
      default:
        this.appendMessage("system", `未知命令：/${name}（/help 查看）`);
    }
    this.tui.setFocus(this.input);
  }
}
