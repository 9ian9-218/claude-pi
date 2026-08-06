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
import { agentLoop } from "./agent-loop.ts";
import { triggerHooks } from "./hook.ts";
import type { ChatMessage } from "./client.ts";
import { SessionManager } from "./session-manager.ts";
import { TuiApp } from "./tui/app.ts";
import { handleSessionCommand } from "./tui/session-commands.ts";
import { setTuiApp } from "./tui/ui-provider.ts";
import { getMCPHub } from "./mcp/hub.ts";
import { getCurrentWorktreeTaskId } from "./worktree.ts";
import { getWorkdir } from "./workdir.ts";
import { ExtensionManager } from "./extensions/loader.ts";
import { currentModelLabel } from "./ai-runtime.ts";
import { registerExtensionTool, buildTool } from "./tool.ts";
import { registerSlashCommand, clearSlashCommands } from "./commands.ts";
import { LoopOptions } from "./loop-options.ts";
import { TEAM_LEAD_NAME } from "./teammates/constants.ts";
import { createTeam, readTeamConfig } from "./teammates/team-helpers.ts";
import { startLeadInboxPoller } from "./teammates/poller.ts";
import { createAgentContext } from "./teammates/context.ts";

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
    await triggerHooks("UserPromptSubmit", query);
    void triggerHooks("user_prompt_submit", query);
    if (session) {
      session.appendMessage({ role: "user", content: query });
      const ctx = session.buildSessionContext();
      const messages: ChatMessage[] = ctx.messages;
      await agentLoop(messages, { session });
    } else {
      const messages: ChatMessage[] = [{ role: "user", content: query }];
      await agentLoop(messages);
    }
    process.stdout.write(USER_PROMPT);
  }
  rl.close();
}

const DEFAULT_TEAM = "default";

/** 确保 default 团队存在并启动 lead 收件箱轮询（对齐 main.py _init_lead_team） */
function initLeadTeam(): void {
  const ctx = createAgentContext();
  ctx.agentName = TEAM_LEAD_NAME;
  ctx.role = "lead";
  if (readTeamConfig(DEFAULT_TEAM) === null) {
    createTeam(DEFAULT_TEAM, TEAM_LEAD_NAME);
  }
  ctx.teamName = DEFAULT_TEAM;
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

/** 单次对话模式（-p 打印 / --mode json）：管道 stdin 合并进首轮提示（对齐 pi print 模式） */
async function runSingleTurn(args: string[], mode: "print" | "json"): Promise<void> {
  const stdin = await readAllStdin();
  const positionals = args.filter((a) => !a.startsWith("-"));
  const query = stdin.trim() || positionals.join(" ") || "";
  if (!query) {
    console.error("Error: no input. Pipe stdin or pass a prompt argument.");
    process.exit(1);
  }
  const session = pickSession(args);
  const loopOptions = { quietOutput: true };
  const { LoopOptions } = await import("./loop-options.ts");
  const opts = new LoopOptions(loopOptions);

  if (session) {
    session.appendMessage({ role: "user", content: query });
    const ctx = session.buildSessionContext();
    await agentLoop(ctx.messages, { session, loopOptions: opts });
    const messages = session.buildSessionContext().messages;
    const final = finalContent(messages);
    if (mode === "print") {
      process.stdout.write((final ?? "(no output)") + "\n");
    } else {
      process.stdout.write(JSON.stringify({ turns: messages, final }, null, 2) + "\n");
    }
  } else {
    const messages: ChatMessage[] = [{ role: "user", content: query }];
    await agentLoop(messages, { loopOptions: opts });
    const final = finalContent(messages);
    if (mode === "print") {
      process.stdout.write((final ?? "(no output)") + "\n");
    } else {
      process.stdout.write(JSON.stringify({ turns: messages, final }, null, 2) + "\n");
    }
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
    autocompleteCommands: () => [
      {
        name: "model",
        description: "切换模型",
        getArgumentCompletions: async () => {
          const { getModelRuntime } = await import("./ai-runtime.ts");
          const runtime = await getModelRuntime();
          const models = runtime.getAvailableSnapshot();
          return models.map((m) => ({
            value: `${m.provider}/${m.id}`,
            label: `${m.provider}/${m.id}`,
          }));
        },
      },
    ],
    onNewSession: () => {
      sessionRef.current = SessionManager.create(process.cwd());
    },
    onSessionCommand: (name, rest, a) => handleSessionCommand(a, sessionRef, name, rest),
    onReload: () => {
      void extManager.reload(cliPaths);
    },
    statusText: () => `${currentModelLabel()} | ${process.cwd()}`,
    onQuery: async (query) => {
      await triggerHooks("UserPromptSubmit", query);
      const session = sessionRef.current;
      // 08：Esc 可中断回合（controller 由 handleSubmit 创建）
      const signal = app.getTurnSignal() ?? undefined;
      app.beginAssistantTurn();
      try {
        if (session) {
          session.appendMessage({ role: "user", content: query });
          const ctx = session.buildSessionContext();
          await agentLoop(ctx.messages, {
            session,
            loopOptions: new LoopOptions({
              quietOutput: true,
              onStream: (d) => {
                // 05：thinking 增量进 thinking 区，正文进正文区
                if (d.kind === "thinking") app.appendThinking(d.delta);
                else app.appendStream(d.delta);
              },
              onToolEvent: (e) => app.handleToolEvent(e),
              onTurnEnd: (e) => app.finishAssistantTurn(e),
              signal,
            }),
          });
        } else {
          const messages: ChatMessage[] = [{ role: "user", content: query }];
          await agentLoop(messages, {
            loopOptions: new LoopOptions({
              quietOutput: true,
              onStream: (d) => {
                if (d.kind === "thinking") app.appendThinking(d.delta);
                else app.appendStream(d.delta);
              },
              onToolEvent: (e) => app.handleToolEvent(e),
              onTurnEnd: (e) => app.finishAssistantTurn(e),
              signal,
            }),
          });
        }
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
  const args = process.argv.slice(2);

  if (args.includes("--version") || args.includes("-v")) {
    process.stdout.write(readVersion() + "\n");
    process.exit(0);
  }

  initRuntime();

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
