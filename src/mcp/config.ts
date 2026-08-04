/** MCP 配置（对齐 mcp_integration/config.py）：.agent/mcp.json */
import fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT, resolveAgentDirs } from "../config.ts";

export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string | null;
  autoConnect: boolean;
}

function parseServer(name: string, raw: Record<string, unknown>): McpServerConfig {
  const command = raw["command"];
  if (typeof command !== "string" || !command) {
    throw new Error(`MCP server '${name}' missing string 'command'`);
  }
  const args = raw["args"] ?? [];
  if (!Array.isArray(args)) throw new Error(`MCP server '${name}' 'args' must be a list`);
  const env = raw["env"] ?? {};
  if (typeof env !== "object" || env === null || Array.isArray(env)) {
    throw new Error(`MCP server '${name}' 'env' must be an object`);
  }
  const cwd = raw["cwd"];
  if (cwd !== undefined && cwd !== null && typeof cwd !== "string") {
    throw new Error(`MCP server '${name}' 'cwd' must be a string`);
  }
  const autoConnect = Boolean(raw["autoConnect"] ?? raw["auto_connect"]);
  return {
    name,
    command,
    args: args.map(String),
    env: Object.fromEntries(Object.entries(env as Record<string, unknown>).map(([k, v]) => [k, String(v)])),
    cwd: typeof cwd === "string" ? cwd : null,
    autoConnect,
  };
}

export function loadMcpConfig(configPath?: string): Record<string, McpServerConfig> {
  const p = configPath ?? path.join(resolveAgentDirs(PROJECT_ROOT).agentsDir, "mcp.json");
  if (!fs.existsSync(p)) return {};
  const data = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
  const servers = (data["mcpServers"] ?? data["servers"] ?? {}) as Record<string, unknown>;
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
    throw new Error("mcp.json: mcpServers must be an object");
  }
  const out: Record<string, McpServerConfig> = {};
  for (const [name, raw] of Object.entries(servers)) {
    out[name] = parseServer(name, raw as Record<string, unknown>);
  }
  return out;
}

/** 测试隔离 */
export function mcpConfigPath(): string {
  return path.join(resolveAgentDirs(PROJECT_ROOT).agentsDir, "mcp.json");
}
