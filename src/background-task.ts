/**
 * background-task.ts — 后台任务（对齐 src/background_task.py）
 *
 * 长耗时 bash 后台运行：子进程事件驱动 + stall 看门狗（静默/交互 prompt 检测），
 * 完成/停滞时经 message-queue 注入 <task_notification>。
 */
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { runProcess } from "./process-runner.ts";
import { shellInvocation } from "./sandbox.ts";
import { writeFileAtomic } from "./atomic-write.ts";
import type { ToolResult } from "./results.ts";
import { getWorkdir } from "./workdir.ts";
import { getWorkspaceBinding } from "./workdir.ts";
import { withRepositoryLock } from "./repository-lock.ts";
import { recoverFileTransactions } from "./file-transactions.ts";
import { enqueuePendingNotification } from "./message-queue.ts";
import { triggerHooks } from "./hook.ts";

// ── Stall 看门狗配置（默认对齐 Python；测试可注入） ───────────────────────

export let STALL_CHECK_INTERVAL_S = 5;
export let STALL_THRESHOLD_S = 15;
export let STALL_MAX_WATCHDOG_S = 300;
export const STALL_TAIL_BYTES = 1024;

export interface StallConfig {
  checkIntervalS?: number;
  thresholdS?: number;
  maxWatchdogS?: number;
}

export function setStallConfig(cfg: StallConfig): void {
  if (cfg.checkIntervalS !== undefined) STALL_CHECK_INTERVAL_S = cfg.checkIntervalS;
  if (cfg.thresholdS !== undefined) STALL_THRESHOLD_S = cfg.thresholdS;
  if (cfg.maxWatchdogS !== undefined) STALL_MAX_WATCHDOG_S = cfg.maxWatchdogS;
}

export function restoreStallConfig(): void {
  STALL_CHECK_INTERVAL_S = 5;
  STALL_THRESHOLD_S = 15;
  STALL_MAX_WATCHDOG_S = 300;
}

// ── 交互 prompt 模式（对齐 LocalShellTask.tsx L24-38） ────────────────────

const PROMPT_PATTERNS = [
  /\(y\/n\)/i,
  /\[y\/n\]/i,
  /\(yes\/no\)/i,
  /\b(?:Do you|Would you|Shall I|Are you sure|Ready to)\b.*\? *$/i,
  /Press (any key|Enter)/i,
  /Continue\?/i,
  /Overwrite\?/i,
];

export function looksLikePrompt(tail: string): boolean {
  const lines = tail.trimEnd().split("\n");
  const lastLine = lines[lines.length - 1] ?? "";
  return PROMPT_PATTERNS.some((p) => p.test(lastLine));
}

// ── 慢操作启发式 ──────────────────────────────────────────────────────────

const SLOW_KEYWORDS = [
  "install",
  "build",
  "test",
  "deploy",
  "compile",
  "docker build",
  "pip install",
  "npm install",
  "cargo build",
  "pytest",
  "make",
];

export function isSlowOperation(toolName: string, toolInput: Record<string, unknown>): boolean {
  if (toolName !== "run_bash") return false;
  const cmd = String(toolInput["command"] ?? "").toLowerCase();
  return SLOW_KEYWORDS.some((kw) => cmd.includes(kw));
}

export function shouldRunBackground(toolName: string, toolInput: Record<string, unknown>): boolean {
  if ("run_in_background" in toolInput) {
    return Boolean(toolInput["run_in_background"]);
  }
  return isSlowOperation(toolName, toolInput);
}

// ── 通知构造 ──────────────────────────────────────────────────────────────

export function enqueueStallNotification(
  bgId: string,
  command: string,
  toolUseId: string | null,
  tail: string,
  options: { recipient?: string; isPrompt?: boolean } = {},
): void {
  const isPrompt = options.isPrompt ?? true;
  let summary: string;
  let action: string;
  if (isPrompt) {
    summary = `Background command "${command}" appears to be waiting for interactive input`;
    action =
      "The command is likely blocked on an interactive prompt. Kill this task and re-run " +
      "with piped input (e.g., `echo y | command`) or a non-interactive flag if one exists.";
  } else {
    summary = `Background command "${command}" has no output for ${STALL_THRESHOLD_S}s`;
    action =
      `The command has been running for over ${STALL_MAX_WATCHDOG_S}s without output. ` +
      "Kill this task if it is stuck, or wait for it to finish if it is just slow.";
  }
  const toolUseLine = toolUseId ? `  <tool_use_id>${toolUseId}</tool_use_id>\n` : "";
  const message =
    `<task_notification>\n` +
    `  <task_id>${bgId}</task_id>\n` +
    toolUseLine +
    `  <summary>${summary}</summary>\n` +
    `\nLast output:\n${tail.trimEnd()}\n\n` +
    action;
  enqueuePendingNotification(message, "next", { recipient: options.recipient });
}

const COMPLETION_OUTPUT_PREVIEW = 2000;

export function buildCompletionSummary(toolName: string, command: string, exitCode: number): string {
  if (toolName === "run_bash" && command) {
    return `Background command "${command}" completed (exit code ${exitCode})`;
  }
  return `Background ${toolName} completed (exit code ${exitCode})`;
}

export function enqueueCompletionNotification(
  bgId: string,
  summary: string,
  output: string,
  toolUseId: string | null,
  options: { recipient?: string; status?: string } = {},
): void {
  let preview: string;
  if (output.length <= COMPLETION_OUTPUT_PREVIEW) {
    preview = output;
  } else {
    const omitted = output.length - COMPLETION_OUTPUT_PREVIEW;
    preview = `${output.slice(0, COMPLETION_OUTPUT_PREVIEW)}\n... (${omitted} more chars)`;
  }
  const toolUseLine = toolUseId ? `  <tool_use_id>${toolUseId}</tool_use_id>\n` : "";
  const message =
    `<task_notification>\n` +
    `  <task_id>${bgId}</task_id>\n` +
    `  <status>${options.status === undefined || options.status === "success" ? "completed" : options.status}</status>\n` +
    `  <summary>${summary}</summary>\n` +
    toolUseLine +
    `\nOutput:\n${preview}\n` +
    `</task_notification>`;
  enqueuePendingNotification(message, "later", { recipient: options.recipient });
}

// ── 后台执行 ──────────────────────────────────────────────────────────────

interface RunningTask {
  process: ChildProcess | null;
  command: string;
  toolName: string;
  controller: AbortController;
  recordPath?: string;
}
const runningTasks = new Map<string, RunningTask>();
let bgCounter = 0;

export async function runBashWithExitCode(
  command: string,
  options: { bgId?: string; toolUseId?: string | null; recipient?: string; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<[string, number]> {
  const result = await runBackgroundProcess(command, options);
  // Compatibility surface. Structured results are persisted and used by notifications.
  return [((result.stdout ?? "") + (result.stderr ?? "")).trim().slice(0, 50_000) || (result.exitCode !== null ? "(no output)" : result.output), result.exitCode ?? 1];
}

async function runBackgroundProcess(command: string, options: {
  bgId?: string; toolUseId?: string | null; recipient?: string; signal?: AbortSignal; timeoutMs?: number;
}): Promise<ToolResult> {
  let tail = "", lastGrowth = Date.now();
  const started = Date.now();
  let notified = false;
  const watchdog = setInterval(() => {
    if (notified || Date.now() - lastGrowth < STALL_THRESHOLD_S * 1000) return;
    const prompt = looksLikePrompt(tail);
    if (prompt || Date.now() - started >= STALL_MAX_WATCHDOG_S * 1000) {
      notified = true;
      enqueueStallNotification(options.bgId ?? "", command, options.toolUseId ?? null, tail, { recipient: options.recipient, isPrompt: prompt });
    }
  }, STALL_CHECK_INTERVAL_S * 1000);
  try {
    const invocation = shellInvocation(command, getWorkdir());
    const run = () => runProcess(invocation.executable, invocation.args, {
      cwd: getWorkdir(), env: invocation.env, signal: options.signal,
      timeoutMs: options.timeoutMs ?? 120_000, outputLimitBytes: 50_000,
      onOutput: chunk => { tail = (tail + chunk).slice(-STALL_TAIL_BYTES); lastGrowth = Date.now(); },
      onSpawn: process => { const task = runningTasks.get(options.bgId ?? ""); if (task) task.process = process; },
    });
    return await (getWorkspaceBinding() ? run() : withRepositoryLock(getWorkdir(), () => { recoverFileTransactions(); return run(); }));
  } catch (e) { return { status: "error", output: `Error: ${String(e)}`, exitCode: null }; }
  finally { clearInterval(watchdog); }
}

export function killBgTask(bgId: string): string {
  const info = runningTasks.get(bgId);
  if (!info) return `Error: no running task '${bgId}'`;
  info.controller.abort();
  return `Killed background task '${bgId}' (${info.command.slice(0, 60)})`;
}

export interface ToolCallLike { id?: string; function: { name: string; arguments: string } }

export function startBackgroundTask(toolCall: ToolCallLike, args: Record<string, unknown>, options: { recipient?: string; signal?: AbortSignal } = {}): string {
  bgCounter += 1;
  const bgId = `bg_${String(bgCounter).padStart(4, "0")}`;
  const command = String(args.command ?? "");
  const toolName = toolCall.function.name;
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  const jobDir = path.join(getWorkdir(), ".agent", "jobs");
  fs.mkdirSync(jobDir, { recursive: true });
  // The process identity in the filename prevents stale IDs overwriting previous runs.
  const recordPath = path.join(jobDir, `${process.pid}-${bgId}.json`);
  const record = { id: bgId, ownerPid: process.pid, command, startedAt: Date.now(), status: "running" };
  writeFileAtomic(recordPath, JSON.stringify(record));
  runningTasks.set(bgId, { process: null, command, toolName, controller, recordPath });
  void (async () => {
    let result: ToolResult;
    try {
      result = toolName === "run_bash"
        ? await runBackgroundProcess(command, { bgId, signal, toolUseId: toolCall.id, recipient: options.recipient, timeoutMs: typeof args.timeout_ms === "number" ? args.timeout_ms : undefined })
        : { status: "error", output: "Error: only run_bash supports background execution", exitCode: 1 };
      writeFileAtomic(recordPath, JSON.stringify({ ...record, status: result.status, finishedAt: Date.now(), result }));
      await triggerHooks("PostToolUse", { name: toolName, input: args }, result.output);
      enqueueCompletionNotification(bgId, buildCompletionSummary(toolName, command, result.exitCode ?? 1), result.output, toolCall.id ?? null, { recipient: options.recipient, status: result.status });
    } catch (e) {
      // Background rejections must never become an unhandled process-wide failure.
      enqueueCompletionNotification(bgId, "Background task failed", `Error: ${String(e)}`, toolCall.id ?? null, { recipient: options.recipient, status: "error" });
    } finally { runningTasks.delete(bgId); }
  })();
  return bgId;
}

export function getBackgroundJobs(): unknown[] {
  const dir = path.join(getWorkdir(), ".agent", "jobs");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith(".json")).map(file => {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      if (record.status === "running" && (record.ownerPid !== process.pid || !runningTasks.has(record.id))) {
        // A different process may still own it; do not kill arbitrary PIDs after restart.
        record.status = "unknown_after_restart";
      }
      return record;
    } catch { return { status: "error", file }; }
  });
}
