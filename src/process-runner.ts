import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ToolResult, ExecutionStatus } from "./results.ts";

export interface ProcessOptions {
  cwd: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  outputLimitBytes?: number;
  env?: NodeJS.ProcessEnv;
  onOutput?: (chunk: string) => void;
  onSpawn?: (child: ChildProcess) => void;
  artifactDir?: string;
}

export function killProcessTree(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  if (!child.pid) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch { /* Already exited. */ }
}

/** Bounded in-memory previews; full output is streamed to a bounded artifact. */
export async function runProcess(executable: string, args: string[], options: ProcessOptions): Promise<ToolResult> {
  if (options.signal?.aborted) return { status: "cancelled", output: "Error: command cancelled", exitCode: null };
  const started = performance.now();
  const cap = options.outputLimitBytes ?? 64 * 1024;
  const dir = options.artifactDir ?? path.join(options.cwd, ".task_outputs", "processes");
  fs.mkdirSync(dir, { recursive: true });
  const artifact = path.join(dir, `${randomUUID()}.log`);
  const fd = fs.openSync(artifact, "wx", 0o600);
  const maxArtifactBytes = 16 * 1024 * 1024;
  let artifactBytes = 0;
  let stdout = "", stderr = "", retained = 0, truncated = false;
  let stopped: ExecutionStatus | undefined;
  return new Promise<ToolResult>((resolve) => {
    const child = spawn(executable, args, {
      cwd: options.cwd, env: options.env ?? process.env,
      detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
    });
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const stop = (status: ExecutionStatus) => {
      if (stopped) return;
      stopped = status;
      killProcessTree(child);
      escalation = setTimeout(() => killProcessTree(child, "SIGKILL"), 250);
    };
    const abort = () => stop("cancelled");
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => stop("timeout"), options.timeoutMs ?? 120_000);
    let settled = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (escalation) clearTimeout(escalation);
      // A shell can exit before its grandchildren. Terminate the complete group on cancellation.
      if (stopped) killProcessTree(child, "SIGKILL");
      options.signal?.removeEventListener("abort", abort);
      fs.closeSync(fd);
      const status = stopped ?? (error || code !== 0 ? "error" : "success");
      let output = `${stdout}${stderr}`.trim() || "(no output)";
      if (error) output = `Error: ${error.message}`;
      else if (status !== "success") output = `Error: command ${status} (exit code ${code ?? "none"})\n${output}`;
      if (truncated) output += `\n[Output truncated; log: ${artifact}]`;
      resolve({ status, output, exitCode: code, signal, stdout, stderr,
        durationMs: Math.round(performance.now() - started), truncated, artifactRefs: [artifact] });
    };
    const consume = (buffer: Buffer, stream: "stdout" | "stderr") => {
      if (settled) return;
      try {
      const save = buffer.subarray(0, Math.max(0, maxArtifactBytes - artifactBytes));
      if (save.length) { fs.writeSync(fd, save); artifactBytes += save.length; }
      const preview = buffer.subarray(0, Math.max(0, cap - retained));
      retained += preview.length;
      if (stream === "stdout") stdout += preview.toString(); else stderr += preview.toString();
      truncated ||= preview.length < buffer.length || save.length < buffer.length;
      options.onOutput?.(preview.toString());
      } catch (e) {
        stderr = `${stderr.slice(0, cap)}\nOutput capture failed: ${String((e as Error)?.message ?? e)}`;
        stop("error");
      }
    };
    child.stdout?.on("data", (b: Buffer) => consume(b, "stdout"));
    child.stderr?.on("data", (b: Buffer) => consume(b, "stderr"));
    child.once("error", e => finish(null, null, e));
    child.once("close", (code, signal) => finish(code, signal));
    try { options.onSpawn?.(child); } catch (e) { killProcessTree(child, "SIGKILL"); finish(null, null, e as Error); }
    if (options.signal?.aborted) abort();
  });
}
