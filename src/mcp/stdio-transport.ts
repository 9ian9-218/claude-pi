import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { JSONRPCMessageSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { checkJsonComplexity, cleanMcpText, type McpLimits } from "./limits.ts";

export class McpTransportError extends Error {
  constructor(message: string, readonly fatal: boolean, readonly kind: "protocol" | "limit" | "process") { super(message); this.name = "McpTransportError"; }
}

/** SDK-compatible transport owning pipes, bounded parser work, and the complete process group. */
export class ManagedStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private child?: ChildProcessWithoutNullStreams;
  private closing?: Promise<void>;
  private ended = false;
  private notified = false;
  private exitPromise?: Promise<void>;
  private frameBuffer = Buffer.alloc(0);
  private frameBytes = 0;
  private tail = Buffer.alloc(0);
  private bucket = { start: performance.now(), stdout: 0, stderr: 0, messages: 0 };
  private protocolErrors = { start: performance.now(), count: 0 };
  private writes = new Set<(error: Error) => void>();
  exitCode: number | null = null;
  exitSignal: string | null = null;

  constructor(private config: { command: string; args: string[]; env: Record<string, string>; cwd: string; preflight?: (message: JSONRPCMessage) => void }, readonly limits: McpLimits) {}
  get pid(): number | null { return this.ended ? null : this.child?.pid ?? null; }
  get stderrTail(): string { return cleanMcpText(this.tail.toString("utf8")); }

  async start(): Promise<void> {
    if (this.child || this.ended) throw new Error("MCP transport cannot be started twice");
    const child = spawn(this.config.command, this.config.args, { cwd: this.config.cwd, env: { ...getDefaultEnvironment(), ...this.config.env }, detached: process.platform !== "win32", shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    this.exitPromise = new Promise(resolve => child.once("close", () => resolve()));
    child.on("error", error => this.fail(new McpTransportError(error.message, true, "process")));
    child.stdin.on("error", error => { if (!this.ended) this.fail(new McpTransportError(error.message, true, "process")); });
    child.stdout.on("error", error => this.fail(new McpTransportError(error.message, true, "process")));
    child.stderr.on("error", error => this.fail(new McpTransportError(error.message, true, "process")));
    child.stdout.on("data", (chunk: Buffer) => this.consume(chunk));
    // Always drain stderr; retain only a bounded tail, without writing unlimited logs.
    child.stderr.on("data", (chunk: Buffer) => {
      if (this.ended) return;
      if (!this.rate("stderr", chunk.length)) return;
      this.tail = Buffer.concat([this.tail, chunk.subarray(Math.max(0, chunk.length - this.limits.stderrTailBytes))]).subarray(-this.limits.stderrTailBytes);
    });
    child.once("exit", (code, signal) => {
      this.exitCode = code; this.exitSignal = signal;
      // Descendants may still hold inherited pipes open even after their parent exits.
      void this.close();
    });
    child.once("close", () => { this.ended = true; this.notifyClose(); });
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  }

  private rate(stream: "stdout" | "stderr" | "messages", amount: number): boolean {
    const now = performance.now();
    if (now - this.bucket.start >= 1000) this.bucket = { start: now, stdout: 0, stderr: 0, messages: 0 };
    this.bucket[stream] += amount;
    const cap = stream === "stdout" ? this.limits.maxStdoutBytesPerSecond : stream === "stderr" ? this.limits.maxStderrBytesPerSecond : this.limits.maxMessagesPerSecond;
    if (this.bucket[stream] > cap) { this.fail(new McpTransportError(`MCP ${stream} rate limit exceeded`, true, "limit")); return false; }
    return true;
  }

  private consume(chunk: Buffer): void {
    if (this.ended || !this.rate("stdout", chunk.length)) return;
    let offset = 0;
    while (offset < chunk.length && !this.ended) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(offset, end);
      if (this.frameBytes + part.length > this.limits.maxFrameBytes) { this.fail(new McpTransportError("MCP frame byte limit exceeded", true, "limit")); return; }
      const required = this.frameBytes + part.length;
      if (required > this.frameBuffer.length) {
        // Geometric growth bounds both copies and metadata for byte-at-a-time peers.
        const capacity = Math.min(this.limits.maxFrameBytes, Math.max(required, 4096, this.frameBuffer.length * 2));
        const grown = Buffer.allocUnsafe(capacity);
        this.frameBuffer.copy(grown, 0, 0, this.frameBytes); this.frameBuffer = grown;
      }
      part.copy(this.frameBuffer, this.frameBytes); this.frameBytes = required;
      if (newline < 0) break;
      if (!this.rate("messages", 1)) return;
      const frame = this.frameBuffer.subarray(0, this.frameBytes);
      this.frameBytes = 0;
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(frame).replace(/\r$/, "");
        checkJsonComplexity(text, this.limits);
        const message = JSONRPCMessageSchema.parse(JSON.parse(text));
        this.config.preflight?.(message);
        this.onmessage?.(message);
      } catch (error) {
        if (error instanceof McpTransportError) { this.fail(error); return; }
        const now = performance.now();
        if (now - this.protocolErrors.start >= 10_000) this.protocolErrors = { start: now, count: 0 };
        const fatal = ++this.protocolErrors.count >= this.limits.maxProtocolErrors || String(error).includes("complexity limit");
        // Do not reflect arbitrary peer bytes or huge Zod errors into logs.
        this.fail(new McpTransportError(fatal ? "MCP protocol error threshold exceeded" : "Invalid MCP JSON-RPC frame", fatal, "protocol"));
      }
      offset = end + 1;
    }
  }

  private fail(error: McpTransportError): void {
    if (this.ended) return;
    try { this.onerror?.(error); }
    finally { if (error.fatal) void this.close(); }
  }

  private notifyClose(): void {
    if (this.notified) return;
    this.notified = true;
    for (const reject of this.writes) reject(new Error("MCP connection closed"));
    this.writes.clear(); this.frameBuffer = Buffer.alloc(0); this.frameBytes = 0;
    this.onclose?.();
  }

  private async killTree(signal: NodeJS.Signals): Promise<void> {
    const pid = this.child?.pid;
    if (!pid) return;
    if (process.platform === "win32") {
      await new Promise<void>(resolve => execFile("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { timeout: 2000, windowsHide: true }, () => resolve()));
    } else { try { process.kill(-pid, signal); } catch { /* The owned group already exited. */ } }
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.ended = true;
    // Publish the promise before callbacks, which may themselves call close().
    this.closing = Promise.resolve().then(async () => {
      const child = this.child;
      if (!child) return;
      const wait = async (ms: number) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([this.exitPromise, new Promise<void>(resolve => { timer = setTimeout(resolve, ms); })]); }
        finally { if (timer) clearTimeout(timer); }
      };
      child.stdin.end();
      await wait(this.limits.shutdownGraceMs);
      // Terminate descendants even when the directly spawned process already exited.
      await this.killTree("SIGTERM");
      await wait(this.limits.shutdownGraceMs);
      await this.killTree("SIGKILL");
      await wait(250);
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    });
    this.notifyClose();
    return this.closing;
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.ended || !this.child?.stdin.writable) throw new Error("MCP transport is not connected");
    if (this.writes.size >= 16) throw new Error("MCP pending write limit exceeded");
    const text = JSON.stringify(message);
    if (Buffer.byteLength(text) > this.limits.maxFrameBytes) throw new Error("MCP outbound frame byte limit exceeded");
    checkJsonComplexity(text, this.limits);
    return new Promise<void>((resolve, reject) => {
      this.writes.add(reject);
      this.child!.stdin.write(text + "\n", error => { this.writes.delete(reject); if (error) reject(error); else resolve(); });
    });
  }
}
