/** MCP 配置（对齐 mcp_integration/config.py）：.agent/mcp.json */
import fs from "node:fs";
import path from "node:path";
import { AGENT_ROOT, resolveAgentDirs } from "../config.ts";
import { checkJsonComplexity, resolveMcpLimits, DEFAULT_MCP_LIMITS, type McpLimits } from "./limits.ts";

export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string | null;
  autoConnect: boolean;
  autoRestart?: boolean;
  limits?: Partial<McpLimits>;
}

function parseServer(name: string, raw: Record<string, unknown>): McpServerConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`MCP server '${name}' must be an object`);
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
  for (const field of ["autoConnect", "auto_connect", "autoRestart"]) if (raw[field] !== undefined && typeof raw[field] !== "boolean") throw new Error(`MCP server '${name}' ${field} must be boolean`);
  const limits = resolveMcpLimits(raw.limits ?? {});
  return {
    name,
    command,
    args: args.map(String),
    env: Object.fromEntries(Object.entries(env as Record<string, unknown>).map(([k, v]) => [k, String(v)])),
    cwd: typeof cwd === "string" ? cwd : null,
    autoConnect,
    autoRestart: raw.autoRestart === true,
    limits,
  };
}

export function loadMcpConfig(configPath?: string, root = AGENT_ROOT): Record<string, McpServerConfig> {
  const p = configPath ?? path.join(resolveAgentDirs(root).agentsDir, "mcp.json");
  if (!fs.existsSync(p)) return {};
  if (!fs.lstatSync(p).isFile() || fs.statSync(p).size > 256 * 1024) throw new Error("MCP configuration must be a regular file of at most 256 KiB");
  const text = fs.readFileSync(p, "utf8");
  checkJsonComplexity(text, { ...DEFAULT_MCP_LIMITS });
  const data = JSON.parse(text) as Record<string, unknown>;
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("MCP configuration must be an object");
  const servers = (data["mcpServers"] ?? data["servers"] ?? {}) as Record<string, unknown>;
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
    throw new Error("mcp.json: mcpServers must be an object");
  }
  const out: Record<string, McpServerConfig> = Object.create(null);
  if (Object.keys(servers).length > 16) throw new Error("At most 16 MCP servers may be configured");
  for (const [name, raw] of Object.entries(servers)) {
    const server = parseServer(name, raw as Record<string, unknown>);
    server.cwd = server.cwd ? path.resolve(root, server.cwd) : root;
    out[name] = server;
  }
  return out;
}
