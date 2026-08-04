#!/usr/bin/env node
/**
 * cli.ts — 入口（工单 01 范围）
 *
 * 当前能力：--version / banner / .agent 目录树初始化。
 * 交互 REPL（02a）、运行模式分派（13）、TUI（14）在后续工单接入。
 */
import fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT, initRuntime } from "./config.ts";

function readVersion(): string {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8"),
  ) as { version: string };
  return pkg.version;
}

const args = process.argv.slice(2);

if (args.includes("--version") || args.includes("-v")) {
  process.stdout.write(readVersion() + "\n");
  process.exit(0);
}

initRuntime();

process.stdout.write(`claude-pi ${readVersion()} — 类 Claude Code 架构的 TS Agent 运行时\n`);
process.stdout.write("交互界面开发中（工单 02a / 13 / 14）…\n");
