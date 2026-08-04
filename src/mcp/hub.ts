/**
 * hub.ts — MCP Hub（对齐 mcp_integration/hub.py）
 *
 * stdio 连接外部 MCP server（@modelcontextprotocol/sdk），工具以
 * mcp__{server}__{tool} 前缀暴露给 LLM；本地 server 暴露内置工具为
 * mcp__local__*（由 local-server.ts 提供）。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { type Tool } from "@modelcontextprotocol/sdk/types.js";
import { normalizeMcpName, buildPrefixedName, parsePrefixedName, LOCAL_SERVER_NAME } from "./names.ts";
import { sanitizeOpenaiTool, type OpenaiTool } from "../schema-strict.ts";
import { loadMcpConfig, type McpServerConfig } from "./config.ts";

export interface RegisteredMcpTool {
  prefixedName: string;
  serverName: string;
  safeServerName: string;
  originalToolName: string;
  description: string;
  parameters: Record<string, unknown>;
  isReadOnly: boolean;
}

interface ServerState {
  name: string;
  safeName: string;
  client: Client;
  transport: StdioClientTransport;
  tools: Tool[];
  toolByPrefixed: Map<string, RegisteredMcpTool>;
}

export class MCPHub {
  private servers = new Map<string, ServerState>();
  private tools = new Map<string, RegisteredMcpTool>();

  static toolReadOnly(description: string): boolean {
    const lowered = description.toLowerCase();
    return lowered.includes("(readonly)") || lowered.includes("(read-only)") || lowered.includes("read only");
  }

  static formatCallResult(result: { isError?: boolean; content: unknown[]; structuredContent?: unknown }): string {
    const parts: string[] = [];
    for (const block of result.content ?? []) {
      const text = (block as { text?: string }).text;
      if (text) parts.push(text);
    }
    if (result.isError) {
      return JSON.stringify({
        status: "error",
        message: parts.join("\n") || "MCP tool error",
      });
    }
    if (parts.length === 0 && result.structuredContent !== undefined) {
      return JSON.stringify(result.structuredContent);
    }
    return parts.join("\n") || "(no output)";
  }

  async connectStdio(config: McpServerConfig): Promise<string> {
    const safeName = normalizeMcpName(config.name);
    if (this.servers.has(safeName)) {
      throw new Error(`MCP server '${config.name}' already connected`);
    }
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: config.env,
      cwd: config.cwd ?? process.cwd(),
      stderr: "pipe",
    });
    const client = new Client({ name: "claude-pi", version: "0.1.0" });
    await client.connect(transport);
    const listed = await client.listTools();

    const state: ServerState = {
      name: config.name,
      safeName,
      client,
      transport,
      tools: listed.tools,
      toolByPrefixed: new Map(),
    };
    for (const tool of listed.tools) {
      const prefixed = buildPrefixedName(config.name, tool.name);
      const reg: RegisteredMcpTool = {
        prefixedName: prefixed,
        serverName: config.name,
        safeServerName: safeName,
        originalToolName: tool.name,
        description: tool.description ?? "",
        parameters: (tool.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
        isReadOnly: MCPHub.toolReadOnly(tool.description ?? ""),
      };
      state.toolByPrefixed.set(prefixed, reg);
      this.tools.set(prefixed, reg);
    }
    this.servers.set(safeName, state);
    console.log(`  \x1b[31m[mcp] connected: ${config.name} → ${listed.tools.map((t) => t.name).join(", ")}\x1b[0m`);
    return `Connected to ${config.name}: ${listed.tools.map((t) => t.name).join(", ")}`;
  }

  async disconnect(name: string): Promise<string> {
    const safeName = normalizeMcpName(name);
    const state = this.servers.get(safeName);
    if (!state) throw new Error(`MCP server '${name}' is not connected`);
    for (const prefixed of state.toolByPrefixed.keys()) {
      this.tools.delete(prefixed);
    }
    this.servers.delete(safeName);
    await state.transport.close();
    console.log(`  \x1b[31m[mcp] disconnected: ${name}\x1b[0m`);
    return `Disconnected from ${name}`;
  }

  /** 按配置连接全部 autoConnect server */
  async connectFromConfig(): Promise<void> {
    const configs = loadMcpConfig();
    for (const cfg of Object.values(configs)) {
      if (!cfg.autoConnect) continue;
      try {
        await this.connectStdio(cfg);
      } catch (e) {
        console.log(`  \x1b[31m[mcp] failed to connect ${cfg.name}: ${String((e as Error).message)}\x1b[0m`);
      }
    }
  }

  listServers(): string[] {
    return [...this.servers.values()].map((s) => s.name);
  }

  listTools(): RegisteredMcpTool[] {
    return [...this.tools.values()];
  }

  getTool(prefixedName: string): RegisteredMcpTool | null {
    return this.tools.get(prefixedName) ?? null;
  }

  async callPrefixedTool(prefixedName: string, arguments_: Record<string, unknown>): Promise<string> {
    const [server, tool] = parsePrefixedName(prefixedName);
    const state = this.servers.get(server);
    if (!state) throw new Error(`MCP server '${server}' is not connected`);
    const result = await state.client.callTool({ name: tool, arguments: arguments_ });
    return MCPHub.formatCallResult(result as unknown as { isError?: boolean; content: unknown[]; structuredContent?: unknown });
  }

  toOpenaiTools(excluded?: Set<string>): OpenaiTool[] {
    const out: OpenaiTool[] = [];
    for (const reg of this.tools.values()) {
      if (excluded?.has(reg.prefixedName)) continue;
      out.push(
        sanitizeOpenaiTool(reg.prefixedName, {
          type: "function",
          function: {
            name: reg.prefixedName,
            description: reg.description,
            parameters: reg.parameters,
          },
        }),
      );
    }
    return out;
  }

  async shutdown(): Promise<void> {
    for (const name of [...this.servers.keys()]) {
      try {
        await this.disconnect(name);
      } catch {
        // 忽略
      }
    }
  }

  /** 测试隔离 */
  clearForTest(): void {
    this.servers.clear();
    this.tools.clear();
  }
}

// 全局单例（对齐 Python 模块级 hub）
let _hub: MCPHub | null = null;

export function getMCPHub(): MCPHub {
  if (!_hub) _hub = new MCPHub();
  return _hub;
}

export function resetMCPHub(): void {
  _hub = null;
}

export { LOCAL_SERVER_NAME };
