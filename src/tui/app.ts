/**
 * app.ts — TUI 宿主（03 重构：组件化聊天区，对齐 pi）
 *
 * 布局：顶部 MessageList（消息块）+ 底部输入行 + 状态行（07 换 footer）。
 * 事件流：Input 提交 → 斜杠命令或 onQuery；流式增量经 appendStream 进
 * 当前助手块（beginAssistantTurn/endAssistantTurn 管理生命周期）。
 * 角色前缀已移除（ADR：消息以分块+背景色区分，对齐 pi）。
 */
import {
  TUI,
  Container,
  Editor,
  Input,
  Text,
  SelectList,
  CombinedAutocompleteProvider,
  type Terminal,
  type SelectItem,
  type Component,
  type AutocompleteItem,
  type SlashCommand,
} from "@earendil-works/pi-tui";
import { MessageList } from "./messages/message-list.ts";
import { UserMessageComponent } from "./messages/user-message.ts";
import { AssistantMessageComponent } from "./messages/assistant-message.ts";
import { SystemMessageComponent } from "./messages/system-message.ts";
import { ToolExecutionComponent } from "./messages/tool-execution.ts";
import { Footer } from "./footer.ts";
import { SELECT_LIST_THEME, overlayTitle } from "./select-style.ts";
import { getSlashCommand, listSlashCommands } from "../commands.ts";
import { theme } from "./theme/theme.ts";
import type { SwarmPermissionRequest, PermissionResolution } from "../permission-sync.ts";
import type { ToolUiEvent, TurnEndEvent } from "../ui-events.ts";

const BUILTIN_COMMANDS: Array<AutocompleteItem | SlashCommand> = [
  { name: "new", description: "开新会话" },
  { name: "help", description: "显示帮助" },
  { name: "quit", description: "退出" },
  { name: "status", description: "显示状态" },
  { name: "reload", description: "重载扩展" },
  { name: "tree", description: "会话树导航" },
  { name: "fork", description: "Fork 当前会话" },
  { name: "clone", description: "Clone 当前会话" },
  { name: "resume", description: "恢复历史会话" },
  { name: "name", description: "设置会话名" },
  { name: "session", description: "显示会话信息" },
];

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
  /** 自动补全附加命令（06）：扩展命令 + /model 模型名等动态项 */
  autocompleteCommands?: () => Array<AutocompleteItem | SlashCommand>;
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
  readonly chat: MessageList;
  readonly editor: Editor;
  private readonly onQuery: (q: string) => Promise<void> | void;
  private readonly onNewSession?: () => void;
  private readonly onSessionCommand?: (name: string, rest: string, app: TuiApp) => Promise<void> | void;
  private readonly onReload?: () => void;
  private readonly statusTextFn?: () => string;
  private readonly footer: Footer;
  private readonly root = new Container();
  private busy = false;
  private running = true;
  /** 当前流式助手块（beginAssistantTurn → endAssistantTurn） */
  private streamingComponent: AssistantMessageComponent | null = null;
  /** 08：当前回合的中断控制器（Esc → abort → signal 链路） */
  private abortController: AbortController | null = null;
  /** 工具执行块注册表（04）：id → 组件 */
  private readonly toolComponents = new Map<string, ToolExecutionComponent>();
  /** 工具块折叠偏好：新块跟随此状态，Ctrl+O 切换全部（对齐 pi app.tools.expand） */
  private toolOutputExpanded = false;
  private readonly autocompleteCommands?: () => Array<AutocompleteItem | SlashCommand>;

  constructor(options: TuiAppOptions) {
    this.onQuery = options.onQuery;
    this.onNewSession = options.onNewSession;
    this.onSessionCommand = options.onSessionCommand;
    this.onReload = options.onReload;
    this.statusTextFn = options.statusText;
    this.autocompleteCommands = options.autocompleteCommands;
    this.chat = new MessageList();

    const resizeAware = new ResizeAwareTerminal(options.terminal, () => this.layout());
    this.tui = new TUI(resizeAware);
    this.footer = new Footer(this.tui);
    this.editor = new Editor(
      this.tui,
      {
        borderColor: (s) => theme.fg("border", s),
        selectList: SELECT_LIST_THEME,
      },
      { paddingX: 1 },
    );
    this.refreshAutocomplete();
    this.root.addChild(this.chat);
    this.root.addChild(this.editor);
    this.root.addChild(this.footer);
    this.updateFooter();

    this.editor.onSubmit = (value) => {
      this.editor.addToHistory(value);
      void this.handleSubmit(value);
    };

    // 08：Esc 中断当前生成（对齐 pi app.interrupt）；空闲时放行（编辑器取消补全等）
    this.tui.addInputListener((data) => {
      if (data === "\x1b") {
        if (this.busy) {
          this.interrupt();
          return { consume: true };
        }
      }
      return { consume: false };
    });

    // 06：Ctrl+C 清空输入框（对齐 pi app.clear）；空输入时 Ctrl+D 退出（app.exit）
    this.tui.addInputListener((data) => {
      if (data === "\x03") {
        this.editor.setText("");
        this.tui.requestRender();
        return { consume: true };
      }
      if (data === "\x04") {
        if (!this.editor.getText()) {
          this.running = false;
          this.tui.stop();
        }
        return { consume: false };
      }
      return { consume: false };
    });

    // 04：Ctrl+O 折叠/展开全部工具输出（对齐 pi app.tools.expand）
    this.tui.addInputListener((data) => {
      if (data === "\x0f") {
        this.toggleToolExpansion();
        return { consume: true };
      }
      return { consume: false };
    });
    // 05：Ctrl+T 折叠/展开 thinking 块（对齐 pi app.thinking.toggle）
    this.tui.addInputListener((data) => {
      if (data === "\x14") {
        this.toggleThinkingExpansion();
        return { consume: true };
      }
      return { consume: false };
    });
    // 05：PgUp/PgDn 整页滚动聊天区
    this.tui.addInputListener((data) => {
      if (data === "\x1b[5~") {
        this.chat.scrollUp(this.chat.getViewportHeight());
        this.tui.requestRender();
        return { consume: true };
      }
      if (data === "\x1b[6~") {
        this.chat.scrollDown(this.chat.getViewportHeight());
        this.tui.requestRender();
        return { consume: true };
      }
      return { consume: false };
    });
    // 09：Ctrl+L 打开模型选择器（对齐 pi app.model.select）
    this.tui.addInputListener((data) => {
      if (data === "\x0c") {
        if (!this.busy) {
          void this.openModelSelector();
        }
        return { consume: true };
      }
      return { consume: false };
    });

    if (options.initialText) {
      this.appendSystem(options.initialText.trim(), "accent");
    }

    this.layout();
    this.tui.setFocus(this.editor);
  }

  /** 06：重建自动补全（/reload 后扩展命令变化时调用） */
  refreshAutocomplete(): void {
    const extra = this.autocompleteCommands?.() ?? [];
    const commands: Array<AutocompleteItem | SlashCommand> = [
      ...BUILTIN_COMMANDS,
      ...listSlashCommands().map((c) => ({ name: c.name, description: c.description })),
      ...extra,
    ];
    this.editor.setAutocompleteProvider(
      new CombinedAutocompleteProvider(commands, process.cwd()),
    );
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

  /** 聊天区全部文本（测试断言用） */
  getChatText(): string {
    return this.chat.getText();
  }

  /** 工具事件（04）：start 创建灰底块，result 更新绿/红底 */
  handleToolEvent(event: ToolUiEvent): void {
    if (event.phase === "start") {
      let component = this.toolComponents.get(event.id);
      if (!component) {
        component = new ToolExecutionComponent(event.name, event.id, event.args);
        component.setExpanded(this.toolOutputExpanded);
        this.toolComponents.set(event.id, component);
        this.chat.addChild(component);
      }
    } else if (event.phase === "result") {
      let component = this.toolComponents.get(event.id);
      if (!component) {
        component = new ToolExecutionComponent(event.name, event.id, event.args);
        component.setExpanded(this.toolOutputExpanded);
        this.toolComponents.set(event.id, component);
        this.chat.addChild(component);
      }
      component.updateResult(event.result ?? "", event.isError ?? false);
    }
    this.tui.requestRender();
  }

  /** Ctrl+O：切换全部工具块展开/折叠（对齐 pi app.tools.expand） */
  toggleToolExpansion(): void {
    this.toolOutputExpanded = !this.toolOutputExpanded;
    for (const component of this.toolComponents.values()) {
      component.setExpanded(this.toolOutputExpanded);
    }
    this.tui.requestRender();
  }

  /** 工具块折叠状态（测试用） */
  getToolOutputExpanded(): boolean {
    return this.toolOutputExpanded;
  }

  /** thinking 增量（05）：追加到当前助手块 thinking 区 */
  appendThinking(delta: string): void {
    if (!this.streamingComponent) {
      this.beginAssistantTurn();
    }
    this.streamingComponent!.appendThinking(delta);
    this.tui.requestRender();
  }

  /** Ctrl+T：折叠/展开当前助手块 thinking（对齐 pi app.thinking.toggle） */
  toggleThinkingExpansion(): void {
    if (this.streamingComponent) {
      const next = !this.streamingComponent.isThinkingExpanded();
      this.streamingComponent.setThinkingExpanded(next);
    }
    this.tui.requestRender();
  }

  /** 08：开启可中断回合，返回 AbortSignal（Esc 中止）；handleSubmit 自动调用 */
  beginTurn(): AbortSignal {
    this.abortController?.abort();
    this.abortController = new AbortController();
    return this.abortController.signal;
  }

  /** 08：当前回合的 AbortSignal（onQuery 内取用；空闲时 null） */
  getTurnSignal(): AbortSignal | null {
    return this.abortController?.signal ?? null;
  }

  /** 08：回合结束，清理中断控制器 */
  endTurn(): void {
    this.abortController = null;
  }

  /** 08：Esc 中断当前生成（busy 时）；空闲无操作 */
  private interrupt(): void {
    if (this.busy) {
      this.abortController?.abort();
    }
  }

  /** 开始助手回合：创建流式块，后续 appendStream 增量进该块 */
  beginAssistantTurn(): void {
    this.endAssistantTurn();
    this.streamingComponent = new AssistantMessageComponent();
    this.chat.addChild(this.streamingComponent);
    this.tui.requestRender();
  }

  /** 结束助手回合：固化当前块，后续流式增量自动开新块 */
  endAssistantTurn(): void {
    this.streamingComponent = null;
  }

  /** 回合结束状态（08：中止/错误显示在助手块底部） */
  finishAssistantTurn(event: TurnEndEvent): void {
    this.streamingComponent?.setTurnEnd(event);
    this.streamingComponent = null;
    this.tui.requestRender();
  }

  /** 流式增量：追加到当前助手块（无块时自动创建） */
  appendStream(delta: string): void {
    if (!this.streamingComponent) {
      this.beginAssistantTurn();
    }
    this.streamingComponent!.appendDelta(delta);
    this.tui.requestRender();
  }

  /** 追加完整消息（user/assistant/system）；消息以分块渲染，无角色前缀 */
  appendMessage(role: string, content: string): void {
    if (content.includes("<teammate-message")) {
      this.chat.addChild(new SystemMessageComponent(content, "accent"));
    } else if (content.includes("<task_notification>")) {
      this.chat.addChild(new SystemMessageComponent(content, "success"));
    } else if (role === "user") {
      this.chat.addChild(new UserMessageComponent(content));
    } else if (role === "assistant") {
      if (content) {
        this.beginAssistantTurn();
        this.streamingComponent?.setText(content);
        this.endAssistantTurn();
      }
    } else {
      this.chat.addChild(new SystemMessageComponent(content));
    }
    this.tui.requestRender();
  }

  /** 系统消息（命令回显等） */
  appendSystem(content: string, kind: "muted" | "accent" | "success" | "warning" | "error" = "muted"): void {
    this.chat.addChild(new SystemMessageComponent(content, kind));
    this.tui.requestRender();
  }

  private updateFooter(): void {
    const status = this.statusTextFn?.() ?? "";
    const [model = "?", ...rest] = status.split(" | ");
    this.footer.setInfo(model, rest.join(" | ") || process.cwd());
  }

  /** Working 状态（07）：agent-loop 运行时显示 spinner */
  setWorking(working: boolean, message = "Working…"): void {
    this.footer.setWorking(working, message);
  }

  private layout(): void {
    const rows = this.tui.terminal.rows;
    this.chat.setViewportHeight(Math.max(3, rows - 3));
  }

  private updateStatus(): void {
    this.updateFooter();
    this.tui.requestRender();
  }

  private async handleSubmit(value: string): Promise<void> {
    if (this.busy) return;
    const trimmed = value.trim();
    this.editor.setText("");
    if (trimmed.startsWith("/")) {
      await this.handleCommand(trimmed);
      return;
    }
    if (!trimmed) return;
    this.busy = true;
    this.updateStatus();
    this.setWorking(true);
    this.appendMessage("user", trimmed);
    this.beginTurn();
    try {
      await this.onQuery(trimmed);
    } finally {
      this.endTurn();
      this.setWorking(false);
      this.busy = false;
      this.updateStatus();
      this.tui.setFocus(this.editor);
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
      const list = new SelectList(items, 5, SELECT_LIST_THEME);
      const overlay = new Container();
      overlay.addChild(
        new Text(
          `${theme.fg("warning", `⚠ Permission request from ${label}`)}\n` +
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
        this.tui.setFocus(this.editor);
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
        this.chat.clear();
        this.appendSystem("新会话已开始。输入 /help 查看命令。", "accent");
        break;
      case "help":
        this.appendSystem(
          ["/new 开新会话", "/help 显示帮助", "/quit 退出", "/status 显示状态", "Ctrl+C / Esc 退出"].join("\n"),
          "accent",
        );
        break;
      case "quit":
      case "exit":
      case "q":
        this.running = false;
        this.tui.stop();
        break;
      case "status":
        this.appendSystem(this.statusTextFn?.() ?? "no status");
        break;
      case "reload":
        this.onReload?.();
        this.refreshAutocomplete();
        this.appendSystem("扩展已重载。", "success");
        break;
      default: {
        // 扩展命令注册表（16）
        const ext = getSlashCommand(name);
        if (ext) {
          try {
            const result = await ext.handler(cmd.slice(1 + name.length).trim());
            this.appendSystem(String(result));
          } catch (e) {
            this.appendSystem(`扩展命令错误：${String((e as Error).message)}`, "error");
          }
          break;
        }
        if (this.onSessionCommand) {
          await this.onSessionCommand(name, cmd.slice(1 + name.length).trim(), this);
          break;
        }
        this.appendSystem(`未知命令：/${name}（/help 查看）`, "warning");
      }
    }
    this.tui.setFocus(this.editor);
  }

  /** 09：模型选择器（Ctrl+L；对齐 pi app.model.select） */
  private async openModelSelector(): Promise<void> {
    const { getModelRuntime } = await import("../ai-runtime.ts");
    let models: Array<{ provider: string; id: string }> = [];
    try {
      const runtime = await getModelRuntime();
      models = runtime
        .getAvailableSnapshot()
        .map((m) => ({ provider: m.provider, id: m.id }));
    } catch {
      models = [];
    }
    if (models.length === 0) {
      this.appendSystem("无可用模型（/login 或配置 models.json）", "warning");
      return;
    }
    const items: SelectItem[] = models.map((m) => ({
      value: `${m.provider}/${m.id}`,
      label: `${m.provider}/${m.id}`,
      description: m.provider,
    }));
    const picked = await this.showSelector(items, "选择模型");
    if (!picked) return;
    const { setCurrentModel } = await import("../ai-runtime.ts");
    const found = models.find((m) => `${m.provider}/${m.id}` === picked.value);
    if (found) {
      const runtime = await getModelRuntime();
      const model = runtime.getModel(found.provider, found.id);
      if (model) {
        setCurrentModel(model);
        this.appendSystem(`已切换模型：${picked.value}`, "success");
        this.updateFooter();
      }
    }
  }

  /** 通用选择器（15b：树节点/fork 目标/会话列表），返回选中项或 null */
  showSelector(items: SelectItem[], title: string): Promise<SelectItem | null> {
    return new Promise((resolve) => {
      const list = new SelectList(items, 8, SELECT_LIST_THEME);
      const overlay = new Container();
      overlay.addChild(new Text(`${overlayTitle(title)}\n`, 1, 1));
      overlay.addChild(list);
      const handle = this.tui.showOverlay(overlay, { width: "70%", anchor: "center" });
      const removeListener = this.tui.addInputListener((data) => {
        list.handleInput(data);
        return { consume: true };
      });
      const finish = (item: SelectItem | null) => {
        removeListener();
        handle.hide();
        this.tui.setFocus(this.editor);
        resolve(item);
      };
      list.onSelect = (item) => finish(item);
      list.onCancel = () => finish(null);
    });
  }

  /** 清空聊天区并显示系统消息（会话切换后） */
  refreshChat(text: string): void {
    this.chat.clear();
    this.appendSystem(text);
  }

  /** 输入对话框（17 ctx.ui.input）：overlay + Input 组件 */
  showInputDialog(message: string): Promise<string | null> {
    return new Promise((resolve) => {
      const input = new Input();
      const overlay = new Container();
      overlay.addChild(new Text(`${overlayTitle(message)}\n`, 1, 1));
      overlay.addChild(input);
      const handle = this.tui.showOverlay(overlay, { width: "70%", anchor: "center" });
      const removeListener = this.tui.addInputListener((data) => {
        input.handleInput(data);
        return { consume: true };
      });
      const finish = (value: string | null) => {
        removeListener();
        handle.hide();
        this.tui.setFocus(this.editor);
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
      this.tui.setFocus(this.editor);
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
