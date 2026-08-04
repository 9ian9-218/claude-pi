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

async function runRepl(): Promise<void> {
  const messages: ChatMessage[] = [];
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
      messages.length = 0;
      console.log("=".repeat(50));
      process.stdout.write(USER_PROMPT);
      continue;
    }
    if (["q", "exit", ""].includes(query.trim().toLowerCase())) break;
    await triggerHooks("UserPromptSubmit", query);
    messages.push({ role: "user", content: query });
    await agentLoop(messages);
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--version") || args.includes("-v")) {
    process.stdout.write(readVersion() + "\n");
    process.exit(0);
  }

  initRuntime();
  initLeadTeam();

  process.stdout.write(`claude-pi ${readVersion()} — 类 Claude Code 架构的 TS Agent 运行时\n`);
  process.stdout.write("输入 /new 清空会话，q/exit 退出。\n");
  await runRepl();
}

void main();
