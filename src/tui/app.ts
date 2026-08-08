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
import { StartupMessageComponent } from "./messages/startup-message.ts";
import { Footer } from "./footer.ts";
import { SELECT_LIST_THEME, overlayTitle } from "./select-style.ts";
import { TurnController } from "./turn-controller.ts";
import { ToolBlockRegistry } from "./tool-registry.ts";
import { Keymap } from "./keymap.ts";
import { handleLoginCommand } from "./login.ts";
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
  /** 架构 B：职责拆分 */
  private readonly turns = new TurnController();
  private readonly keymap = new Keymap();
  private readonly tools: ToolBlockRegistry;
  private running = true;
  /** 登录模式（/login）：Esc 取消；onCancel 中止 ModelRuntime.login 流程 */
  private loginMode: { onCancel: () => void } | null = null;
  /** 模态输入（promptForInput）：提交/取消回调 */
  private loginPromptResolver: ((value: string | null) => void) | null = null;
  private savedOnSubmit: ((value: string) => void) | undefined = undefined;
  /** 当前流式助手块（beginAssistantTurn → endAssistantTurn） */
  private streamingComponent: AssistantMessageComponent | null = null;
  /** 启动帮助消息（10）：Ctrl+O 同步展开/折叠 */
  private startupMessage: StartupMessageComponent | null = null;
  private readonly autocompleteCommands?: () => Array<AutocompleteItem | SlashCommand>;

  constructor(options: TuiAppOptions) {
    this.onQuery = options.onQuery;
    this.onNewSession = options.onNewSession;
    this.onSessionCommand = options.onSessionCommand;
    this.onReload = options.onReload;
    this.statusTextFn = options.statusText;
    this.autocompleteCommands = options.autocompleteCommands;
    this.chat = new MessageList();
    this.tools = new ToolBlockRegistry((c) => this.chat.addChild(c));

    const resizeAware = new ResizeAwareTerminal(options.terminal, () => this.layout());
    this.tui = new TUI(resizeAware);
    this.tui.addChild(this.root);
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
    // 架构 B：全部键位经 Keymap 注册，单个全局监听器转发
    this.keymap.bind("\x1b", () => {
      // Esc：登录模式取消登录 > 中断生成（busy 时）；空闲时放行给编辑器
      if (this.loginMode) {
        this.cancelLogin();
        return;
      }
      this.turns.interrupt();
    });
    this.keymap.bind("\x03", () => {
      // 06：Ctrl+C 清空输入框（对齐 pi app.clear）
      this.editor.setText("");
      this.tui.requestRender();
    });
    this.keymap.bind("\x04", () => {
      // 06：Ctrl+D 空输入时退出（对齐 pi app.exit）；非空放行给编辑器
      if (!this.editor.getText()) {
        this.exitApp();
      }
    });
    this.keymap.bind("\x0f", () => {
      // 04：Ctrl+O 折叠/展开全部工具输出（对齐 pi app.tools.expand）
      this.toggleToolExpansion();
    });
    this.keymap.bind("\x1b[Z", () => {
      // 对齐 pi app.thinking.cycle：Shift+Tab 循环思考强度
      void this.cycleThinkingLevel();
    });
    this.keymap.bind("\x14", () => {
      // 05：Ctrl+T 折叠/展开 thinking 块（对齐 pi app.thinking.toggle）
      this.toggleThinkingExpansion();
    });
    this.keymap.bind("\x1b[5~", () => {
      // 05：PgUp 整页上翻
      this.chat.scrollUp(this.chat.getViewportHeight());
      this.tui.requestRender();
    });
    this.keymap.bind("\x1b[6~", () => {
      // 05：PgDn 整页下翻
      this.chat.scrollDown(this.chat.getViewportHeight());
      this.tui.requestRender();
    });
    this.keymap.bind("\x0c", () => {
      // 09：Ctrl+L 打开模型选择器（对齐 pi app.model.select）
      if (!this.turns.isBusy()) {
        void this.openModelSelector();
      }
    });
    // 键位语义：Esc 空闲时放行、Ctrl+D 非空时放行（编辑器删除字符）
    this.tui.addInputListener((data) => {
      const isEsc = data === "\x1b";
      const isCtrlD = data === "\x04";
      const isBusyInterrupt = isEsc && this.turns.isBusy();
      const isLoginEsc = isEsc && this.loginMode !== null;
      const isExit = isCtrlD && !this.editor.getText();
      if ((isEsc && !isBusyInterrupt && !isLoginEsc) || (isCtrlD && !isExit)) {
        return { consume: false }; // 放行给编辑器
      }
      const consumed = this.keymap.handle(data);
      return consumed ? { consume: true } : { consume: false };
    });

    if (options.initialText) {
      this.startupMessage = new StartupMessageComponent(options.initialText.trim());
      this.chat.addChild(this.startupMessage);
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

  /** 工具事件（04）：委托 ToolBlockRegistry */
  handleToolEvent(event: ToolUiEvent): void {
    this.tools.handleEvent(event);
    this.tui.requestRender();
  }

  /** Ctrl+O：切换全部工具块展开/折叠（对齐 pi app.tools.expand）；启动帮助同步 */
  toggleToolExpansion(): void {
    this.tools.toggleExpansion();
    this.startupMessage?.setExpanded(this.tools.isExpanded());
    this.tui.requestRender();
  }

  /** 工具块折叠状态（测试用） */
  getToolOutputExpanded(): boolean {
    return this.tools.isExpanded();
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
    return this.turns.beginTurn();
  }

  /** 08：当前回合的 AbortSignal（onQuery 内取用；空闲时 null） */
  getTurnSignal(): AbortSignal | null {
    return this.turns.getSignal();
  }

  /** 08：回合结束，清理中断控制器 */
  endTurn(): void {
    this.turns.endTurn();
  }

  /** 退出应用（/quit、Ctrl+D 空输入） */
  private exitApp(): void {
    this.running = false;
    this.tui.stop();
  }

  // ── 登录模式（/login）：Esc 取消整段流程 ────────────────────────────

  /** 进入登录模式；onCancel 在 Esc 时被调用（中止登录流程） */
  beginLoginMode(onCancel: () => void): void {
    this.loginMode = { onCancel };
  }

  /** 退出登录模式；若有活动模态输入则取消 */
  endLoginMode(): void {
    this.loginMode = null;
    this.finishLoginPrompt(null);
  }

  /** Esc 取消登录：先取消活动输入，再通知登录流程中止 */
  private cancelLogin(): void {
    const mode = this.loginMode;
    this.finishLoginPrompt(null);
    mode?.onCancel();
  }

  /** 模态文本输入（登录 prompt）：提交返回输入值，Esc/取消返回 null */
  promptForInput(message: string, placeholder?: string): Promise<string | null> {
    return new Promise((resolve) => {
      if (this.loginPromptResolver) {
        // 已有活动输入：取消旧的
        this.finishLoginPrompt(null);
      }
      this.loginPromptResolver = resolve;
      this.savedOnSubmit = this.editor.onSubmit;
      this.appendSystem(
        `${message}${placeholder ? `（例如 ${placeholder}）` : ""} — 输入后回车提交，Esc 取消`,
        "accent",
      );
      this.editor.onSubmit = (value) => {
        this.finishLoginPrompt(value);
      };
      this.editor.setText("");
      this.tui.setFocus(this.editor);
      this.tui.requestRender();
    });
  }

  /** 结束活动模态输入：恢复编辑器 onSubmit 并清空输入框 */
  private finishLoginPrompt(value: string | null): void {
    const resolver = this.loginPromptResolver;
    this.loginPromptResolver = null;
    if (this.savedOnSubmit) {
      this.editor.onSubmit = this.savedOnSubmit;
      this.savedOnSubmit = undefined;
    }
    this.editor.setText("");
    resolver?.(value);
    this.tui.requestRender();
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
    if (this.turns.isBusy()) return;
    const trimmed = value.trim();
    this.editor.setText("");
    if (trimmed.startsWith("/")) {
      await this.handleCommand(trimmed);
      return;
    }
    if (!trimmed) return;
    this.turns.setBusy(true);
    this.updateStatus();
    this.setWorking(true);
    this.appendMessage("user", trimmed);
    this.beginTurn();
    try {
      await this.onQuery(trimmed);
    } finally {
      this.endTurn();
      this.setWorking(false);
      this.turns.setBusy(false);
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
        // 监听器链路径不自动 requestRender：方向键后显式重绘
        this.tui.requestRender();
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
        if (this.startupMessage) {
          this.startupMessage.setExpanded(true);
        } else {
          this.appendSystem(
            ["/login 登录模型服务商", "/new 开新会话", "/help 显示帮助", "/quit 退出", "/status 显示状态", "Ctrl+C / Esc 退出"].join("\n"),
            "accent",
          );
        }
        break;
      case "login":
        await handleLoginCommand(this, cmd.slice(1 + "login".length).trim());
        break;
      case "model": {
        // /model：无参数开选择器（同 Ctrl+L）；带参数按 provider/id 切换
        const spec = cmd.slice(1 + "model".length).trim();
        if (spec) {
          await this.setModelBySpec(spec);
        } else {
          await this.openModelSelector();
        }
        break;
      }
      case "thinking": {
        // /thinking [level]：无参数显示当前；带参数显式设置
        const spec = cmd.slice(1 + "thinking".length).trim();
        if (spec) {
          await this.setThinkingBySpec(spec);
        } else {
          await this.showThinkingStatus();
        }
        break;
      }
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

  /** /thinking 实现（Shift+Tab 与 /thinking 共用） */
  private async cycleThinkingLevel(): Promise<void> {
    const { cycleThinkingLevel, getThinkingLevel } = await import("../ai-runtime.ts");
    const level = await cycleThinkingLevel();
    if (level === null) {
      this.appendSystem("当前模型不支持思考（或未选择模型）", "warning");
      return;
    }
    this.appendSystem(`Thinking level: ${level}`, "success");
    this.updateFooter();
  }

  private async setThinkingBySpec(spec: string): Promise<void> {
    const {
      setThinkingLevelFromSpec,
      getSupportedThinkingLevels,
      getThinkingLevel,
    } = await import("../ai-runtime.ts");
    const ok = await setThinkingLevelFromSpec(spec);
    if (!ok) {
      this.appendSystem(
        `未知级别：${spec}（可用：off / minimal / low / medium / high / xhigh / max）`,
        "warning",
      );
      return;
    }
    const supported = await getSupportedThinkingLevels();
    const hint = supported ? `（模型支持：${supported.join(" / ")}）` : "";
    this.appendSystem(`Thinking level: ${getThinkingLevel()}${hint}`, "success");
    this.updateFooter();
  }

  private async showThinkingStatus(): Promise<void> {
    const {
      getThinkingLevel,
      getSupportedThinkingLevels,
    } = await import("../ai-runtime.ts");
    const supported = await getSupportedThinkingLevels();
    this.appendSystem(
      `当前思考强度：${getThinkingLevel()}。${supported ? `可用：${supported.join(" / ")}` : "当前模型不支持思考"}（Shift+Tab 循环）`,
      "accent",
    );
  }

  /** /model <spec>：解析 provider/id 或裸 id（跨 provider 搜索）并切换 */
  private async setModelBySpec(spec: string): Promise<void> {
    const { getModelRuntime, setCurrentModel, parseModelSpec } = await import("../ai-runtime.ts");
    let runtime;
    try {
      runtime = await getModelRuntime();
    } catch (e) {
      this.appendSystem(`模型运行时加载失败：${String((e as Error).message)}`, "error");
      return;
    }
    const { provider, id } = parseModelSpec(spec);
    const found = provider
      ? runtime.getModel(provider, id)
      : runtime
          .getProviders()
          .map((p) => runtime.getModel(p.id, id))
          .find((m) => m !== undefined);
    if (found) {
      setCurrentModel(found);
      this.appendSystem(`已切换模型：${found.provider}/${found.id}`, "success");
      this.updateFooter();
      return;
    }
    let available: Array<{ provider: string; id: string }> = [];
    try {
      available = runtime
        .getAvailableSnapshot()
        .map((m) => ({ provider: m.provider, id: m.id }));
    } catch {
      available = [];
    }
    if (available.length === 0) {
      this.appendSystem(`未找到模型 ${spec}（当前无可用模型，Ctrl+L 查看）`, "warning");
    } else {
      this.appendSystem(
        `未找到模型 ${spec}。可用模型：\n${available.map((m) => `  ${m.provider}/${m.id}`).join("\n")}`,
        "warning",
      );
    }
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
        // 监听器链路径不会自动 requestRender（仅焦点组件路径有），
        // 方向键移动选中后必须显式重绘（回归：高亮不移动）
        this.tui.requestRender();
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
