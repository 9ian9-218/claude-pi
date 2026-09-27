#!/usr/bin/env node
/**
 * cli.ts — 入口（工单 02a）
 *
 * 模式：--version 输出版本退出；否则初始化运行时并进入占位 REPL
 * （对齐 main.py：User > 提示、/new /n 清空、q/exit/空行退出、EOF/Ctrl+C 退出）。
 * 运行模式分派（-p / --mode json）归工单 13，TUI 归 14。
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { PROJECT_ROOT, initRuntime } from "./config.ts";
import { installFatalHandlers } from "./fatal.ts";
import { runQuery } from "./query-pipeline.ts";
import { triggerHooks } from "./hook.ts";
import type { ChatMessage } from "./client.ts";
import { UiEventSink } from "./ui-events.ts";
import { SessionManager } from "./session-manager.ts";
import { TuiApp } from "./tui/app.ts";
import { handleSessionCommand } from "./tui/session-commands.ts";
import { setTuiApp } from "./tui/ui-provider.ts";
import { getMCPHub } from "./mcp/hub.ts";
import { ExtensionManager } from "./extensions/loader.ts";
import { currentModelLabel, getCurrentModel, getThinkingLevel } from "./ai-runtime.ts";
import { computeUsageTotals, latestCacheHitRate, computeContextUsage } from "./usage-stats.ts";
import { aggregateAgentUsage } from "./agent-registry.ts";
import { getGitBranch } from "./git-branch.ts";
import { migrateFromPi, migrateNeeded, defaultAgentDir, legacyPiAgentDir, getAgentDir } from "./settings.ts";

/**
 * 配置独立（ADR-0007 修订）：未显式设置 PI_CODING_AGENT_DIR 时，
 * 把 cpi 的全局配置目录注入环境，使 pi-ai 的 ModelRuntime 与本地
 * settings 读取都指向 ~/.claude-pi（进程级 env，不污染系统）。
 */
function ensureOwnConfigDir(): void {
  if (!process.env.PI_CODING_AGENT_DIR && !process.env.TAU_CODING_AGENT_DIR) {
    process.env.PI_CODING_AGENT_DIR = defaultAgentDir();
  }
}

/** 一次性迁移提示（旧 pi 配置存在且新位置缺失时输出提示；新位置尊重 env 覆盖） */
function maybeWarnMigrate(): void {
  const piDir = legacyPiAgentDir();
  try {
    if (migrateNeeded(piDir, getAgentDir())) {
      console.warn(
        `  \x1b[33m[config] 检测到旧 pi 配置（${piDir}）且新配置目录（${getAgentDir()}）为空。\n` +
          `  运行 \`cpi --migrate-config\` 一次性复制 auth/models/settings。\x1b[0m`,
      );
    }
  } catch {
    // 提示失败静默
  }
}

/** 状态行思考强度后缀：非 off 时显示 `:level`（对齐 pi footer model:level） */
function thinkingLabel(): string {
  const level = getThinkingLevel();
  return level === "off" ? "" : `:${level}`;
}
import { registerExtensionTool, buildTool } from "./tool.ts";
import { registerSlashCommand, clearSlashCommands } from "./commands.ts";
import { warmUp } from "./warmup.ts";
import { TEAM_LEAD_NAME } from "./teammates/constants.ts";
import { createTeam, readTeamConfig } from "./teammates/team-helpers.ts";
import { startLeadInboxPoller } from "./teammates/poller.ts";
import { createAgentContext, setAgentContext } from "./teammates/context.ts";

const USER_PROMPT = "\x1b[36mUser >\t \x1b[0m";

/** 扩展 CLI 路径（-e <path>） */
function cliExtensionPaths(args: string[]): string[] {
  const paths: string[] = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === "-e") paths.push(args[i + 1]);
  }
  return paths;
}

/** 创建扩展管理器（16）：工具/命令/appendEntry 接线 */
function createExtensionManager(sessionRef: { current: SessionManager | null }) {
  return new ExtensionManager({
    registerTool: (t) => {
      registerExtensionTool(
        buildTool({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
          execute: t.execute,
        }),
      );
    },
    registerCommand: (n, h) => {
      registerSlashCommand({ name: n, description: "", handler: (args) => h(args, {}) });
    },
    appendEntry: (t, d) => sessionRef.current?.appendCustom(t, d) ?? "",
    beforeLoad: () => {
      clearSlashCommands();
    },
  });
}

function readVersion(): string {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8"),
  ) as { version: string };
  return pkg.version;
}

async function runRepl(initialSession: SessionManager | null): Promise<void> {
  let session = initialSession;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });
  process.on("SIGINT", () => rl.close());

  // 与 TUI 一致：后台预热重模块，并顺带触发模型目录自动更新（best-effort）。
  // 仅交互式会话需要：管道输入的一次性 REPL 里，预热的重模块加载反而会拖长
  // 进程退出（事件循环要等 import 完成）；unref 让定时器本身不吊住退出。
  if (process.stdin.isTTY) {
    const t = setTimeout(() => {
      void warmUp();
    }, 300);
    t.unref?.();
  }
  process.stdout.write(USER_PROMPT);
  for await (const line of rl) {
    let query = line;
    if (["/new", "/n"].includes(query.trim().toLowerCase())) {
      // 开新会话文件（对齐 /new 语义变化：ADR-0003）
      session = SessionManager.create(process.cwd());
      console.log("=".repeat(50));
      process.stdout.write(USER_PROMPT);
      continue;
    }
    if (["q", "exit", ""].includes(query.trim().toLowerCase())) break;
    await runQuery(query, { session });
    process.stdout.write(USER_PROMPT);
  }
  rl.close();
}

const DEFAULT_TEAM = "default";

/** 确保 default 团队存在并启动 lead 收件箱轮询（对齐 main.py _init_lead_team） */
function initLeadTeam(): void {
  if (readTeamConfig(DEFAULT_TEAM) === null) {
    createTeam(DEFAULT_TEAM, TEAM_LEAD_NAME);
  }
  // 写入 ALS：此前 mutate createAgentContext() 返回的默认对象在无 store 时会被丢弃
  setAgentContext(
    createAgentContext({
      role: "lead",
      agentName: TEAM_LEAD_NAME,
      teamName: DEFAULT_TEAM,
    }),
  );
  void startLeadInboxPoller(DEFAULT_TEAM);
}

/** 读取 stdin 全量（print/json 模式的管道输入） */
function readAllStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
  });
}

/** 取最终回复（最后一条 assistant 消息的 content） */
function finalContent(messages: ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && typeof m.content === "string" && m.content.trim()) {
      return m.content;
    }
  }
  return null;
}

/** 带值的 flag：其后的值不是提示词（否则 `--mode json` 会把 "json" 当成用户输入） */
const VALUE_FLAGS = new Set(["--mode", "--session", "--fork", "-e", "--extension"]);

/** 提取位置参数作为提示词（跳过 flag 及其值） */
function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (VALUE_FLAGS.has(a)) {
      i += 1; // 跳过该 flag 的值
      continue;
    }
    if (a.startsWith("-")) continue;
    out.push(a);
  }
  return out;
}

/** 单次对话模式（-p 打印 / --mode json）：管道 stdin 合并进首轮提示（对齐 pi print 模式） */
async function runSingleTurn(args: string[], mode: "print" | "json"): Promise<void> {
  const stdin = await readAllStdin();
  const query = stdin.trim() || positionals(args).join(" ") || "";
  if (!query) {
    console.error("Error: no input. Pipe stdin or pass a prompt argument.");
    process.exit(1);
  }
  const session = pickSession(args);

  if (session) {
    await runQuery(query, { session, quietOutput: true, runHooks: false });
    const messages = session.buildSessionContext().messages;
    emitSingleTurn(messages, mode);
    return;
  }

  // 无会话（--no-session）：调用方持有消息数组，agentLoop 原地追加后取回
  const messages: ChatMessage[] = [];
  await runQuery(query, { quietOutput: true, runHooks: false, outMessages: messages });
  emitSingleTurn(messages, mode);
}

function emitSingleTurn(messages: ChatMessage[], mode: "print" | "json"): void {
  const final = finalContent(messages);
  if (mode === "print") {
    process.stdout.write((final ?? "(no output)") + "\n");
  } else {
    process.stdout.write(JSON.stringify({ turns: messages, final }, null, 2) + "\n");
  }
}

function pickSession(args: string[]): SessionManager | null {
  const cwd = process.cwd();
  const idx = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
  };
  if (args.includes("--no-session")) return null;
  const sessionArg = idx("--session") ?? idx("--fork");
  if (sessionArg) {
    // 支持 id（最近列表匹配）或路径
    const byPath = fs.existsSync(sessionArg) ? sessionArg : null;
    if (byPath) {
      return args.includes("--fork") ? SessionManager.forkFrom(byPath, cwd) : SessionManager.open(byPath);
    }
    const list = SessionManager.list(cwd);
    const match = list.find((s) => s.id.startsWith(sessionArg));
    if (match) {
      return args.includes("--fork") ? SessionManager.forkFrom(match.path, cwd) : SessionManager.open(match.path);
    }
    console.error(`Error: session not found: ${sessionArg}`);
    process.exit(1);
  }
  if (args.includes("-r")) {
    const list = SessionManager.list(cwd);
    if (list.length === 0) {
      console.log("No sessions.");
      process.exit(0);
    }
    list.forEach((s, i) => console.log(`  ${i + 1}. ${s.id.slice(0, 8)}  ${s.path}`));
    console.error("选择会话编号：");
    // 简单交互：从 stdin 读一行
    return null;
  }
  // 默认：继续最近会话（-c 显式同义）
  return SessionManager.continueRecent(cwd);
}

/** TUI 交互模式（TTY 时默认；管道/非 TTY 走 REPL） */
async function runTui(
  initialSession: SessionManager | null,
  extManager: ExtensionManager,
  cliPaths: string[],
): Promise<void> {
  const sessionRef: { current: SessionManager | null } = { current: initialSession };
  const { ProcessTerminal } = await import("@earendil-works/pi-tui");
  const app = new TuiApp({
    terminal: new ProcessTerminal(),
    initialText: "claude-pi — 输入 /help 查看命令\n\n",
    onNewSession: () => {
      sessionRef.current = SessionManager.create(process.cwd());
    },
    onSessionCommand: (name, rest, a) => handleSessionCommand(a, sessionRef, name, rest),
    onReload: () => {
      void extManager.reload(cliPaths);
    },
    // 模型记忆：切换时写入会话 model_change，重启后 restoreModel 恢复
    onModelChange: (m) => {
      sessionRef.current?.appendModelChange(m.provider, m.id);
    },
    // 思考强度记忆：变化时写入会话 thinking_change，重启后恢复
    onThinkingChange: (level) => {
      sessionRef.current?.appendThinkingChange(level);
    },
    statusText: () => `${currentModelLabel()}${thinkingLabel()} | ${process.cwd()}`,
    // footer 统计：渲染时现算（数据在会话 entry 上，零状态）
    footerStats: () => {
      const session = sessionRef.current;
      if (!session) return null;
      const model = getCurrentModel();
      const entries = session.getBranch();
      const messages = session.buildSessionContext().messages;
      // 聚合：把子 agent 子会话的用量并入 totals（footer 才是整个编队的真实成本）
      const fleet = aggregateAgentUsage();
      const totals = computeUsageTotals(entries);
      totals.input += fleet.usage.input;
      totals.output += fleet.usage.output;
      totals.cacheRead += fleet.usage.cacheRead;
      totals.cacheWrite += fleet.usage.cacheWrite;
      totals.cost += fleet.usage.cost;
      return {
        totals,
        latestCacheHitRate: latestCacheHitRate(entries),
        ...(model ? { context: computeContextUsage(entries, messages, model.contextWindow) } : {}),
        ...(fleet.count > 0
          ? { agents: { count: fleet.count, running: fleet.running, usage: fleet.usage } }
          : {}),
        branch: getGitBranch(process.cwd()),
      };
    },
    onQuery: async (query) => {
      await triggerHooks("UserPromptSubmit", query);
      const session = sessionRef.current;
      // 08：Esc 可中断回合（controller 由 handleSubmit 创建）
      const signal = app.getTurnSignal() ?? undefined;
      // 架构 C：UI 事件经 UiEventSink 订阅（stream/tool/turnEnd）
      const sink = new UiEventSink();
      sink.on("stream", (d) => {
        // 05：thinking 增量进 thinking 区，正文进正文区
        if (d.kind === "thinking") app.appendThinking(d.delta);
        else app.appendStream(d.delta);
      });
      sink.on("tool", (e) => app.handleToolEvent(e));
      sink.on("turnEnd", (e) => app.finishAssistantTurn(e));
      // 架构 C 扩展：核心诊断/注入经 notice 通道进聊天区（不再污染 TTY stdout）
      sink.on("notice", (e) => {
        if (e.kind === "inject") app.appendSystem(e.text, "accent");
        else app.appendSystem(e.text);
      });
      app.beginAssistantTurn();
      try {
        // SessionRunner：统一 Turn 装配（Hook 由 onQuery 前置触发，保持 TUI 即时性）
        await runQuery(query, {
          session,
          uiEvents: sink,
          signal,
          thinkingLevel: getThinkingLevel(),
          quietOutput: true,
          runHooks: false,
        });
      } finally {
        app.endAssistantTurn();
        app.endTurn();
      }
    },
  });
  setTuiApp(app);
  // 16：会话生命周期事件
  void triggerHooks("session_start", { sessionId: sessionRef.current?.getSessionId() ?? null });
  // 15a：TUI 权限弹窗接入 askUser（非 TUI 模式保持默认拒绝）
  const { setAskUserImpl } = await import("./permission-sync.ts");
  setAskUserImpl((req, label) => app.askPermission(req, label));

  app.start();
  // 模型/思考强度记忆：会话恢复时还原（不阻塞启动）
  if (sessionRef.current) {
    const ctx = sessionRef.current.buildSessionContext();
    // 思考强度先恢复（footer 在 restoreModel 内刷新，两者同时生效）
    if (ctx.thinkingLevel) {
      // 异步恢复（含 footer 刷新；模型恢复完成时 footer 再刷一次）
      void app.restoreThinkingLevel(ctx.thinkingLevel);
    }
    const modelSpec = ctx.model;
    if (modelSpec) {
      setTimeout(() => {
        void app.restoreModel(modelSpec);
      }, 0);
    }
  }
  // 会话恢复：渲染完整历史（对齐 pi renderSessionItems），
  // 启动帮助之后、新查询之前；/new 清空不受影响
  if (sessionRef.current) {
    app.renderHistory(sessionRef.current.buildSessionContext().messages);
  }
  // 架构 A：重模块（pi-ai/pi-coding-agent/typebox）后台预热，避免首次查询
  // 同步 import 阻塞事件循环 2–7s（交互冻结）。idle 时执行，不阻塞启动。
  setTimeout(() => {
    void warmUp();
  }, 300);
  // 事件循环由 pi-tui 驱动；退出条件由 /quit / Esc / Ctrl+C 触发
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (!app.isRunning()) {
        clearInterval(check);
        app.stop();
        resolve();
      }
    }, 100);
  });
  // TTY raw-mode stdin 的读请求会永久保持事件循环存活（Node 行为）；
  // 对齐 pi：显式退出。
  process.exit(0);
}

async function main(): Promise<void> {
  // 顶层崩溃兜底（04）：未捕获异常不静默退出，记录原因 + 退出码 1
  installFatalHandlers();
  const args = process.argv.slice(2);

  // 配置独立：注入 ~/.claude-pi 全局目录（须在一切配置读取前）
  ensureOwnConfigDir();

  if (args.includes("--version") || args.includes("-v")) {
    process.stdout.write(readVersion() + "\n");
    process.exit(0);
  }

  // 一次性迁移：从 ~/.pi/agent 复制 auth/models/settings 到 ~/.claude-pi
  if (args.includes("--migrate-config")) {
    const copied = migrateFromPi();
    if (copied) {
      process.stdout.write(`配置已从 ~/.pi/agent 迁移到 ${getAgentDir()}\n`);
    } else {
      process.stdout.write(`无需迁移：${getAgentDir()} 已存在全部配置文件（或旧目录为空）\n`);
    }
    process.exit(0);
  }

  initRuntime();

  if (args.includes("--team-mode")) {
    const idx = args.indexOf("--team-mode");
    const mode = args[idx + 1]?.toLowerCase();
    if (mode === "pipeline" || mode === "free") {
      const { setTeamMode } = await import("./settings.ts");
      setTeamMode(mode);
    }
  }
  maybeWarnMigrate();

  // 模型目录刷新（脚本/CI 用；TUI 与 REPL 会在启动后自动后台刷新）
  if (args.includes("--refresh-models")) {
    const { refreshModelCatalog } = await import("./ai-runtime.ts");
    const r = await refreshModelCatalog({ force: args.includes("--force") });
    process.stderr.write(
      [
        r.network ? "已联网检查远端模型目录" : "离线模式（PI_OFFLINE）：仅应用本地缓存",
        `可用模型 ${r.before} → ${r.after}`,
        r.timedOut ? "（超时中断）" : "",
        r.errors.length ? `错误：${r.errors.join("; ")}` : "",
      ]
        .filter(Boolean)
        .join("；") + "\n",
    );
    process.exit(r.errors.length ? 1 : 0);
  }

  // 模式分派（ADR-0003：显式模式，无自动回退）；print/json 不初始化团队/轮询器
  if (args.includes("-p") || args.includes("--print")) {
    // 诊断日志重定向 stderr，保持 stdout 纯净（对拍接口）
    const origLog = console.log;
    console.log = (...a: unknown[]) => process.stderr.write(a.join(" ") + "\n");
    try {
      await runSingleTurn(args, "print");
    } finally {
      console.log = origLog;
    }
    return;
  }
  if (args.includes("--mode") && args[args.indexOf("--mode") + 1] === "json") {
    const origLog = console.log;
    console.log = (...a: unknown[]) => process.stderr.write(a.join(" ") + "\n");
    try {
      await runSingleTurn(args, "json");
    } finally {
      console.log = origLog;
    }
    return;
  }

  initLeadTeam();

  const session = pickSession(args);
  const sessionRef: { current: SessionManager | null } = { current: session };
  const extManager = createExtensionManager(sessionRef);
  void extManager.load(cliExtensionPaths(args));
  if (session?.isPersisted()) {
    const file = session.getSessionFile();
    process.stdout.write(`会话 ${session.getSessionId().slice(0, 8)}（${file}）已恢复\n`);
  }

  // 交互呈现层：TTY → TUI；管道/非 TTY → 行式 REPL（ADR-0003：显式模式不变）
  if (process.stdout.isTTY && process.stdin.isTTY && !args.includes("--repl")) {
    await runTui(session, extManager, cliExtensionPaths(args));
    void triggerHooks("session_end", {});
    return;
  }
  process.stdout.write(`claude-pi ${readVersion()} — 类 Claude Code 架构的 TS Agent 运行时\n`);
  process.stdout.write("输入 /new 开新会话，q/exit 退出。\n");
  await runRepl(session);
  void triggerHooks("session_end", {});
  await getMCPHub().shutdown();
}

void main();
