import { buildTool } from "./core.ts";
import { getMCPHub } from "../mcp/hub.ts";

const namedServer = { type: "object", properties: { name: { type: "string", minLength: 1, maxLength: 64 } }, required: ["name"], additionalProperties: false };
export const CONNECT_MCP_TOOL = buildTool({
  name: "connect_mcp", description: "Connect a named stdio MCP server from .agent/mcp.json. Requires trust for the current project configuration; arbitrary commands are not accepted. Circuit cooldown still applies.", parameters: namedServer,
  execute: (args, ctx) => getMCPHub().connectConfigured(String(args.name), ctx?.signal),
});
export const DISCONNECT_MCP_TOOL = buildTool({
  name: "disconnect_mcp", description: "Disconnect a configured MCP server, remove its tools, and terminate its owned process group.", parameters: namedServer,
  execute: args => getMCPHub().disconnect(String(args.name)),
});
export const RESTART_MCP_TOOL = buildTool({
  name: "restart_mcp", description: "Explicitly restart a configured MCP server after circuit cooldown. Requires current project trust; does not replay failed tool calls.", parameters: namedServer,
  execute: (args, ctx) => getMCPHub().restartConfigured(String(args.name), ctx?.signal),
});
export const LIST_MCP_SERVERS_TOOL = buildTool({
  name: "list_mcp_servers", description: "Inspect MCP connection, circuit, request and bounded stderr diagnostics. Credentials and executable configuration are omitted.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  execute: () => JSON.stringify(getMCPHub().listServerStatus()), isReadOnly: true,
});
