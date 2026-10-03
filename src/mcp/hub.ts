/** MCP lifecycle supervisor; SDK Client still owns protocol negotiation and result validation. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ErrorCode, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { normalizeMcpName, buildPrefixedName, parsePrefixedName, LOCAL_SERVER_NAME } from "./names.ts";
import { sanitizeOpenaiTool, type OpenaiTool } from "../schema-strict.ts";
import { loadMcpConfig, type McpServerConfig } from "./config.ts";
import { isProjectCodeTrusted } from "../workspace-trust.ts";
import { AGENT_ROOT } from "../config.ts";
import { childEnvironment } from "../sandbox.ts";
import { ManagedStdioTransport, McpTransportError } from "./stdio-transport.ts";
import { cleanMcpText, limitUtf8, resolveMcpLimits, DEFAULT_MCP_LIMITS, type McpLimits } from "./limits.ts";

export interface RegisteredMcpTool {
  prefixedName: string; serverName: string; safeServerName: string; originalToolName: string;
  description: string; parameters: Record<string, unknown>; isReadOnly: boolean;
}
type Phase = "connecting" | "ready" | "open" | "failed" | "closed";
interface ServerState {
  config: McpServerConfig; safeName: string; limits: McpLimits; phase: Phase;
  client?: Client; transport?: ManagedStdioTransport; tools: Map<string, RegisteredMcpTool>;
  failures: number; restarts: number; inFlight: number; openUntil: number;
  lastError?: string; closing?: Promise<void>; startup?: Promise<string>;
  restartTimer?: ReturnType<typeof setTimeout>; generation: number; metadataBytes: number;
}
export class McpCallError extends Error {
  constructor(message: string, readonly status: "error" | "timeout" | "cancelled") { super(message); this.name = "McpCallError"; }
}

export class MCPHub {
  private servers = new Map<string, ServerState>();
  private tools = new Map<string, RegisteredMcpTool>();
  private stopping = false;
  constructor(readonly root = AGENT_ROOT) {}

  static toolReadOnly(description: string): boolean {
    const lowered = description.toLowerCase();
    return lowered.includes("(readonly)") || lowered.includes("(read-only)") || lowered.includes("read only");
  }

  static formatCallResult(result: { isError?: boolean; content: unknown[]; structuredContent?: unknown }, cap = DEFAULT_MCP_LIMITS.maxToolOutputBytes): string {
    const parts: string[] = [];
    // Reserve the truncation marker and JSON escaping for isError wrappers.
    const textCap = result.isError ? Math.max(0, Math.floor((cap - 256) / 2)) : Math.max(0, cap - 64);
    let remaining = textCap, truncated = false;
    for (const block of result.content ?? []) {
      const text = (block as { text?: string }).text;
      if (typeof text !== "string" || !text) continue;
      const clean = cleanMcpText(text), kept = limitUtf8(clean, Math.max(0, remaining - 1));
      parts.push(kept); remaining -= Buffer.byteLength(kept) + 1;
      if (kept.length < clean.length || remaining <= 0) { truncated = true; break; }
    }
    let output = parts.join("\n");
    if (!output && result.structuredContent !== undefined) {
      const full = cleanMcpText(JSON.stringify(result.structuredContent));
      output = limitUtf8(full, textCap); truncated ||= output.length < full.length;
    }
    if (truncated) output += "\n[MCP output truncated at byte limit]";
    if (result.isError) return JSON.stringify({ status: "error", message: output || "MCP tool error" });
    return output || "(no output)";
  }

  private diagnostic(state: ServerState, message: string): string {
    let text = cleanMcpText(message);
    for (const [key, value] of Object.entries(state.config.env)) if (/(?:KEY|TOKEN|SECRET|PASS|CREDENTIAL|AUTH)/i.test(key) && value.length >= 4) text = text.split(value).join("[redacted]");
    return limitUtf8(text, 1024);
  }
  private removeTools(state: ServerState): void {
    for (const name of state.tools.keys()) if (this.tools.get(name)?.safeServerName === state.safeName) this.tools.delete(name);
    state.tools.clear(); state.metadataBytes = 0;
  }
  private closeTransport(state: ServerState): Promise<void> {
    const transport = state.transport;
    state.closing = Promise.all([state.closing, transport?.close()]).then(() => {});
    return state.closing;
  }
  private trip(state: ServerState, reason: string): void {
    if (state.phase === "closed" || state.phase === "open" || this.stopping) return;
    state.phase = "open"; state.openUntil = Date.now() + state.limits.cooldownMs;
    state.lastError = this.diagnostic(state, reason); this.removeTools(state);
    void this.closeTransport(state);
    if (state.config.autoRestart && state.restarts < state.limits.maxRestarts) {
      state.restartTimer = setTimeout(() => {
        state.restartTimer = undefined;
        // A changed project config must never silently authorize another launch.
        if (this.stopping || state.phase !== "open" || !isProjectCodeTrusted(this.root)) return;
        try {
          const configured = loadMcpConfig(undefined, this.root)[state.config.name];
          if (!configured || JSON.stringify(configured) !== JSON.stringify(state.config)) return;
          state.restarts++;
          void this.startState(state).catch(() => {});
        } catch (error) { state.lastError = this.diagnostic(state, String(error)); }
      }, state.limits.cooldownMs * Math.min(4, 2 ** state.restarts));
      state.restartTimer.unref();
    }
  }

  async connectStdio(config: McpServerConfig, signal?: AbortSignal): Promise<string> {
    if (this.stopping) throw new Error("MCP hub is shutting down");
    const safeName = normalizeMcpName(config.name);
    if (!safeName || safeName === LOCAL_SERVER_NAME || safeName.includes("__") || safeName.length > 32) throw new Error("Invalid or reserved MCP server name");
    const previous = this.servers.get(safeName);
    if (previous && ["ready", "connecting"].includes(previous.phase)) throw new Error(`MCP server '${safeName}' already connected or connecting`);
    if (previous?.phase === "open" && Date.now() < previous.openUntil) throw new Error(`MCP circuit '${safeName}' is cooling down`);
    if (!previous && this.servers.size >= 16) throw new Error("MCP server limit exceeded");
    await previous?.closing;
    // Copy caller-owned config; retained credentials are never returned by status APIs.
    const state: ServerState = { config: structuredClone(config), safeName, limits: resolveMcpLimits(config.limits), phase: "connecting", tools: new Map(), failures: 0, restarts: 0, inFlight: 0, openUntil: 0, generation: 0, metadataBytes: 0 };
    // Reserve synchronously before the first asynchronous spawn operation.
    if (this.servers.get(safeName) !== previous || this.stopping || (previous && ["connecting", "ready"].includes(previous.phase))) throw new Error("MCP connection changed while waiting for cleanup");
    if (previous) { previous.phase = "closed"; if (previous.restartTimer) clearTimeout(previous.restartTimer); }
    this.servers.set(safeName, state);
    return this.startState(state, signal);
  }

  private startState(state: ServerState, signal?: AbortSignal): Promise<string> {
    state.phase = "connecting";
    state.startup = this.performStart(state, signal);
    return state.startup;
  }
  private async performStart(state: ServerState, signal?: AbortSignal): Promise<string> {
    await state.closing;
    if (this.stopping || state.phase === "closed" || signal?.aborted) throw new McpCallError("MCP connection cancelled", "cancelled");
    state.phase = "connecting"; state.failures = 0; state.lastError = undefined;
    const generation = ++state.generation;
    const environment = childEnvironment();
    for (const key of Object.keys(environment)) if (/(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|(?:^|_)KEY(?:_|$)|API_?KEY)/i.test(key)) delete environment[key];
    const transport = new ManagedStdioTransport({ command: state.config.command, args: state.config.args, env: { ...environment, ...state.config.env } as Record<string, string>, cwd: state.config.cwd ?? this.root,
      preflight: message => {
        if (!("result" in message) || !message.result || typeof message.result !== "object") return;
        const tools = (message.result as { tools?: unknown }).tools;
        if (!Array.isArray(tools)) return;
        // Enforce discovery limits before SDK listTools compiles output-schema validators.
        if (tools.length > state.limits.maxTools) throw new McpTransportError("MCP tool count limit exceeded", true, "limit");
        if (Buffer.byteLength(JSON.stringify(tools)) > state.limits.maxToolMetadataBytes) throw new McpTransportError("MCP tool metadata byte limit exceeded", true, "limit");
      },
    }, state.limits);
    const client = new Client({ name: "claude-pi", version: "0.1.0" });
    state.transport = transport; state.client = client;
    client.onerror = error => {
      if (generation !== state.generation) return;
      state.lastError = this.diagnostic(state, error.message);
      if (error instanceof McpTransportError && error.fatal) this.trip(state, error.message);
    };
    client.onclose = () => {
      if (generation !== state.generation || state.phase === "closed" || this.stopping) return;
      this.trip(state, `MCP process disconnected (exit ${transport.exitCode ?? transport.exitSignal ?? "unknown"})`);
    };
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(new Error("MCP startup deadline exceeded")), state.limits.startupTimeoutMs);
    const abort = () => {
      if (controller.signal.aborted && !signal?.aborted) this.trip(state, "MCP startup deadline exceeded");
      void transport.close();
    };
    combined.addEventListener("abort", abort, { once: true });
    try {
      await client.connect(transport, { signal: combined, timeout: state.limits.startupTimeoutMs, maxTotalTimeout: state.limits.startupTimeoutMs });
      const listed = await client.listTools({}, { signal: combined, timeout: Math.min(15_000, state.limits.startupTimeoutMs), maxTotalTimeout: state.limits.startupTimeoutMs });
      if (state.phase !== "connecting" || combined.aborted || this.stopping) throw new Error("MCP connection closed during startup");
      if (listed.tools.length > state.limits.maxTools) throw new Error("MCP tool count limit exceeded");
      const metadataBytes = Buffer.byteLength(JSON.stringify(listed.tools));
      const otherBytes = [...this.servers.values()].reduce((sum, other) => sum + (other === state ? 0 : other.metadataBytes), 0);
      if (metadataBytes > state.limits.maxToolMetadataBytes || otherBytes + metadataBytes > 512 * 1024) throw new Error("MCP tool metadata byte limit exceeded");
      const registrations = new Map<string, RegisteredMcpTool>();
      for (const tool of listed.tools as Tool[]) {
        const prefixedName = buildPrefixedName(state.safeName, tool.name);
        if (prefixedName.length > 64 || registrations.has(prefixedName) || this.tools.has(prefixedName)) throw new Error("MCP tool name collision or length limit exceeded");
        const reg: RegisteredMcpTool = { prefixedName, serverName: state.config.name, safeServerName: state.safeName, originalToolName: tool.name, description: cleanMcpText(tool.description ?? ""), parameters: tool.inputSchema as Record<string, unknown>, isReadOnly: MCPHub.toolReadOnly(tool.description ?? "") };
        // Ensure the model-facing schema can be constructed before publishing any tools.
        sanitizeOpenaiTool(prefixedName, { type: "function", function: { name: prefixedName, description: reg.description, parameters: reg.parameters } });
        registrations.set(prefixedName, reg);
      }
      state.tools = registrations; state.metadataBytes = metadataBytes; state.phase = "ready";
      for (const [name, reg] of registrations) this.tools.set(name, reg);
      console.error(`[mcp] connected: ${state.safeName} (${registrations.size} tools)`);
      return `Connected to ${state.safeName}: ${[...registrations.keys()].join(", ")}`;
    } catch (error) {
      this.removeTools(state);
      if (signal?.aborted) { state.phase = "closed"; if (state.restartTimer) clearTimeout(state.restartTimer); }
      if (!this.stopping) this.trip(state, this.diagnostic(state, String((error as Error).message ?? error)));
      await this.closeTransport(state);
      const reason = (state.phase as Phase) === "open" && state.lastError ? state.lastError : String((error as Error).message ?? error);
      throw new McpCallError(this.diagnostic(state, reason), signal?.aborted ? "cancelled" : controller.signal.aborted ? "timeout" : "error");
    } finally { clearTimeout(timer); combined.removeEventListener("abort", abort); }
  }

  async connectConfigured(name: string, signal?: AbortSignal): Promise<string> {
    if (!isProjectCodeTrusted(this.root)) throw new Error("MCP launch requires cpi --trust-project-code for the current configuration");
    const config = loadMcpConfig(undefined, this.root)[name];
    if (!config) throw new Error(`MCP server '${cleanMcpText(name)}' is not configured`);
    return this.connectStdio(config, signal);
  }
  async restartConfigured(name: string, signal?: AbortSignal): Promise<string> {
    // Explicit recovery remains subject to trust and circuit cooldown.
    const state = this.servers.get(normalizeMcpName(name));
    if (state?.phase === "open" && Date.now() < state.openUntil) throw new Error("MCP circuit is cooling down");
    if (state) await this.disconnect(name);
    return this.connectConfigured(name, signal);
  }
  async disconnect(name: string): Promise<string> {
    const state = this.servers.get(normalizeMcpName(name));
    if (!state) throw new Error(`MCP server '${cleanMcpText(name)}' is not connected`);
    state.phase = "closed"; if (state.restartTimer) clearTimeout(state.restartTimer); state.restartTimer = undefined;
    this.removeTools(state); await this.closeTransport(state);
    await state.startup?.catch(() => {});
    console.error(`[mcp] disconnected: ${state.safeName}`);
    return `Disconnected from ${state.safeName}`;
  }
  async connectFromConfig(signal?: AbortSignal): Promise<void> {
    const configs = loadMcpConfig(undefined, this.root);
    if (!isProjectCodeTrusted(this.root)) {
      if (Object.values(configs).some(c => c.autoConnect)) console.error("[mcp] Automatic project MCP launches require cpi --trust-project-code.");
      return;
    }
    await Promise.all(Object.values(configs).filter(c => c.autoConnect).map(async config => {
      try { await this.connectStdio(config, signal); }
      catch (error) { console.error(`[mcp] failed to connect ${normalizeMcpName(config.name)}: ${cleanMcpText(String((error as Error).message))}`); }
    }));
  }

  listServers(): string[] { return [...this.servers.values()].filter(s => s.phase === "ready").map(s => s.config.name); }
  listServerStatus(): Array<Record<string, unknown>> {
    return [...this.servers.values()].map(s => ({ name: s.safeName, status: s.phase, pid: s.transport?.pid ?? null, toolCount: s.tools.size, consecutiveFailures: s.failures, restarts: s.restarts, inFlight: s.inFlight, cooldownRemainingMs: Math.max(0, s.openUntil - Date.now()), lastError: s.lastError ?? null, stderrTail: this.diagnostic(s, s.transport?.stderrTail ?? "") }));
  }
  listTools(): RegisteredMcpTool[] { return [...this.tools.values()]; }
  getTool(name: string): RegisteredMcpTool | null { return this.tools.get(name) ?? null; }

  async callPrefixedTool(name: string, arguments_: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const [server] = parsePrefixedName(name), state = this.servers.get(server), reg = this.tools.get(name);
    if (state?.phase === "open") throw new Error(`MCP circuit '${server}' is open; reconnect after cooldown`);
    if (!state || state.phase !== "ready" || !reg) throw new Error(`MCP tool '${name}' is not connected`);
    if (signal?.aborted) throw new McpCallError("MCP tool cancelled before execution", "cancelled");
    if (state.inFlight >= state.limits.maxConcurrentRequests) throw new Error("MCP concurrent request limit exceeded");
    const generation = state.generation; state.inFlight++;
    // SDK request() retains its signal listener. Use a per-request signal so a
    // long-lived turn's shared AbortSignal does not accumulate SDK closures.
    const requestController = signal ? new AbortController() : undefined;
    const relay = () => requestController?.abort(signal?.reason);
    signal?.addEventListener("abort", relay, { once: true });
    try {
      const result = await state.client!.callTool({ name: reg.originalToolName, arguments: arguments_ }, undefined, { signal: requestController?.signal, timeout: state.limits.requestTimeoutMs, maxTotalTimeout: state.limits.requestTimeoutMs });
      if (generation !== state.generation || state.phase !== "ready") throw new Error("MCP connection changed during call");
      state.failures = 0;
      return MCPHub.formatCallResult(result as { isError?: boolean; content: unknown[]; structuredContent?: unknown }, state.limits.maxToolOutputBytes);
    } catch (error) {
      if (signal?.aborted) throw new McpCallError("MCP tool cancelled", "cancelled");
      const timeout = (error as { code?: number }).code === ErrorCode.RequestTimeout;
      // Business errors use isError results. Transport/schema errors count as failures.
      if (generation === state.generation && state.phase === "ready" && ++state.failures >= state.limits.failureThreshold) this.trip(state, timeout ? "Repeated MCP request timeouts" : "Repeated MCP request failures");
      throw new McpCallError(this.diagnostic(state, String((error as Error).message ?? error)), timeout ? "timeout" : "error");
    } finally { signal?.removeEventListener("abort", relay); state.inFlight--; }
  }
  toOpenaiTools(excluded?: Set<string>): OpenaiTool[] {
    return [...this.tools.values()].filter(reg => !excluded?.has(reg.prefixedName)).map(reg => sanitizeOpenaiTool(reg.prefixedName, { type: "function", function: { name: reg.prefixedName, description: reg.description, parameters: reg.parameters } }));
  }
  async shutdown(): Promise<void> {
    this.stopping = true;
    await Promise.all([...this.servers.values()].map(async state => {
      state.phase = "closed"; if (state.restartTimer) clearTimeout(state.restartTimer);
      this.removeTools(state); await this.closeTransport(state); await state.startup?.catch(() => {});
    }));
  }
  clearForTest(): void { if ([...this.servers.values()].some(s => s.transport?.pid)) throw new Error("Shut down MCP processes before clearing state"); this.servers.clear(); this.tools.clear(); }
}
let hub: MCPHub | null = null;
export function getMCPHub(root = AGENT_ROOT): MCPHub { return hub ??= new MCPHub(root); }
export function resetMCPHub(): void { hub = null; }
export { LOCAL_SERVER_NAME };
