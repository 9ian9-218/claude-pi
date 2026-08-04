/**
 * background-task.ts — 后台任务（对齐 src/background_task.py）
 *
 * 长耗时 bash 后台运行：子进程事件驱动 + stall 看门狗（静默/交互 prompt 检测），
 * 完成/停滞时经 message-queue 注入 <task_notification>。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { getWorkdir } from "./workdir.ts";
import {
  enqueuePendingNotification,
  type NotificationPriority,
} from "./message-queue.ts";
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
  options: { recipient?: string } = {},
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
    `  <status>completed</status>\n` +
    `  <summary>${summary}</summary>\n` +
    toolUseLine +
    `\nOutput:\n${preview}\n` +
    `</task_notification>`;
  enqueuePendingNotification(message, "later", { recipient: options.recipient });
}

// ── 后台执行 ──────────────────────────────────────────────────────────────

const BASH_MAX_OUTPUT = 50_000;

interface RunningTask {
  process: ChildProcess | null;
  command: string;
  toolName: string;
}

const runningTasks = new Map<string, RunningTask>();
let bgCounter = 0;

export function runBashWithExitCode(
  command: string,
  options: { bgId?: string; toolUseId?: string | null; recipient?: string } = {},
): Promise<[string, number]> {
  const { bgId = "", toolUseId = null, recipient } = options;
  return new Promise((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawn(command, { shell: true, cwd: getWorkdir(), stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve([`Error: ${String(e)}`, 1]);
      return;
    }

    if (bgId) {
      runningTasks.set(bgId, { process: proc, command, toolName: "run_bash" });
    }

    const outputChunks: string[] = [];
    let lastGrowth = Date.now();
    let lastSize = 0;
    let stallNotified = false;
    const startTime = Date.now();

    proc.stdout?.on("data", (chunk: Buffer) => {
      outputChunks.push(chunk.toString());
      lastGrowth = Date.now();
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      outputChunks.push(chunk.toString());
      lastGrowth = Date.now();
    });

    // stall 看门狗（对齐 Python watchdog 线程）
    const watchdog = setInterval(() => {
      if (proc.exitCode !== null) {
        clearInterval(watchdog);
        return;
      }
      const currentSize = outputChunks.reduce((sum, c) => sum + c.length, 0);
      if (currentSize > lastSize) {
        lastSize = currentSize;
        lastGrowth = Date.now();
        return;
      }
      if (Date.now() - lastGrowth < STALL_THRESHOLD_S * 1000) return;
      const tail = outputChunks.join("").slice(-STALL_TAIL_BYTES);
      const isPrompt = looksLikePrompt(tail);
      const elapsed = Date.now() - startTime;

      if (isPrompt) {
        if (stallNotified) {
          clearInterval(watchdog);
          return;
        }
        stallNotified = true;
        enqueueStallNotification(bgId, command, toolUseId, tail, { recipient, isPrompt: true });
        console.log(`  \x1b[33m[stall watchdog] ${bgId}: interactive prompt detected\x1b[0m`);
        clearInterval(watchdog);
      } else if (elapsed >= STALL_MAX_WATCHDOG_S * 1000) {
        if (stallNotified) {
          clearInterval(watchdog);
          return;
        }
        stallNotified = true;
        enqueueStallNotification(bgId, command, toolUseId, tail, { recipient, isPrompt: false });
        console.log(
          `  \x1b[33m[stall watchdog] ${bgId}: no output for ${STALL_THRESHOLD_S}s (total > ${STALL_MAX_WATCHDOG_S}s)\x1b[0m`,
        );
        clearInterval(watchdog);
      } else {
        lastGrowth = Date.now();
      }
    }, STALL_CHECK_INTERVAL_S * 1000);

    proc.on("close", (code) => {
      clearInterval(watchdog);
      if (bgId) runningTasks.delete(bgId);
      const out = outputChunks.join("").trim();
      const output = out ? out.slice(0, BASH_MAX_OUTPUT) : "(no output)";
      resolve([output, code ?? 1]);
    });
    proc.on("error", (e) => {
      clearInterval(watchdog);
      if (bgId) runningTasks.delete(bgId);
      resolve([`Error: ${String(e)}`, 1]);
    });
  });
}

export function killBgTask(bgId: string): string {
  const info = runningTasks.get(bgId);
  if (!info) return `Error: no running task '${bgId}'`;
  const proc = info.process;
  if (!proc) return `Error: task '${bgId}' is not a bash process and cannot be killed`;
  const command = info.command;
  runningTasks.delete(bgId);
  try {
    proc.kill();
  } catch (e) {
    return `Error killing task '${bgId}': ${String(e)}`;
  }
  console.log(`  \x1b[33m[kill] ${bgId}: ${command.slice(0, 60)}\x1b[0m`);
  return `Killed background task '${bgId}' (${command.slice(0, 60)})`;
}

export interface ToolCallLike {
  id?: string;
  function: { name: string; arguments: string };
}

/** 启动后台任务，返回 bg_id（对齐 start_background_task） */
export function startBackgroundTask(
  toolCall: ToolCallLike,
  args: Record<string, unknown>,
  options: { recipient?: string } = {},
): string {
  bgCounter += 1;
  const bgId = `bg_${String(bgCounter).padStart(4, "0")}`;
  const toolName = toolCall.function.name;
  const command = String(args["command"] ?? "");
  const block = { name: toolName, input: args };

  runningTasks.set(bgId, { process: null, command, toolName });

  void (async () => {
    let output: string;
    let exitCode: number;
    try {
      if (toolName === "run_bash") {
        [output, exitCode] = await runBashWithExitCode(command, {
          bgId,
          toolUseId: toolCall.id ?? null,
          recipient: options.recipient,
        });
      } else {
        // 06：仅 run_bash 后台化（executeToolCall 导入避免循环依赖）
        const { executeToolCall } = await import("./tool.ts");
        output = await executeToolCall(toolCall, args);
        exitCode = output.startsWith("Error") ? 1 : 0;
      }
    } finally {
      runningTasks.delete(bgId);
    }
    triggerHooks("PostToolUse", block, output);
    const summary = buildCompletionSummary(toolName, command, exitCode);
    enqueueCompletionNotification(bgId, summary, output, toolCall.id ?? null, {
      recipient: options.recipient,
    });
    console.log(
      `  \x1b[32m[background done] ${bgId}: ${command.slice(0, 40) || toolName} (exit code ${exitCode})\x1b[0m`,
    );
  })();

  console.log(`  \x1b[33m[background] dispatched ${bgId}: ${command.slice(0, 40) || toolName}\x1b[0m`);
  return bgId;
}

// 测试隔离
export function clearRunningTasks(): void {
  runningTasks.clear();
}
