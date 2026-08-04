/** MCP 工具命名（对齐 mcp_integration/names.py）：mcp__{server}__{tool} */
const DISALLOWED = /[^a-zA-Z0-9_-]/g;
export const MCP_PREFIX = "mcp__";
export const LOCAL_SERVER_NAME = "local";

export function normalizeMcpName(name: string): string {
  return name.replace(DISALLOWED, "_");
}

export function buildPrefixedName(serverName: string, toolName: string): string {
  return `${MCP_PREFIX}${normalizeMcpName(serverName)}__${normalizeMcpName(toolName)}`;
}

export function parsePrefixedName(prefixedName: string): [string, string] {
  if (!prefixedName.startsWith(MCP_PREFIX)) {
    throw new Error(`Not an MCP tool name: ${prefixedName}`);
  }
  const rest = prefixedName.slice(MCP_PREFIX.length);
  const idx = rest.indexOf("__");
  if (idx < 0) throw new Error(`Invalid MCP tool name: ${prefixedName}`);
  return [rest.slice(0, idx), rest.slice(idx + 2)];
}

export function isMcpTool(name: string): boolean {
  return name.startsWith(MCP_PREFIX);
}

export function underlyingToolName(name: string): string {
  if (!isMcpTool(name)) return name;
  const [server, tool] = parsePrefixedName(name);
  if (server === normalizeMcpName(LOCAL_SERVER_NAME)) return tool;
  return name;
}
