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
import { TEAM_LEAD_NAME } from "./teammates/constants.ts";
import { createTeam, readTeamConfig } from "./teammates/team-helpers.ts";
import { startLeadInboxPoller } from "./teammates/poller.ts";
import { createAgentContext } from "./teammates/context.ts";

const USER_PROMPT = "\x1b[36mUser >\t \x1b[0m";

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

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--version") || args.includes("-v")) {
    process.stdout.write(readVersion() + "\n");
    process.exit(0);
  }

  initRuntime();
  initLeadTeam();

  process.stdout.write(`claude-pi ${readVersion()} — 类 Claude Code 架构的 TS Agent 运行时\n`);
  process.stdout.write("输入 /new 开新会话，q/exit 退出。\n");
  const session = pickSession(args);
  if (session?.isPersisted()) {
    const file = session.getSessionFile();
    process.stdout.write(`会话 ${session.getSessionId().slice(0, 8)}（${file}）已恢复\n`);
  }
  await runRepl(session);
}

void main();
