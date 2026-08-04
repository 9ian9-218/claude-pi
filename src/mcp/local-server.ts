/**
 * local-server.ts — 本地 MCP server（对齐 local_mcp_server.py）
 *
 * 通过 stdio 暴露内置工具为 mcp__local__{tool}（供本地 hub 或外部接入）。
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { BUILTIN_TOOLS, executeToolCall } from "../tool.ts";

export async function startLocalMcpServer(): Promise<void> {
  const server = new Server(
    { name: "claude-pi-local", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: BUILTIN_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.parameters,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const result = await executeToolCall({
        id: "local",
        function: { name, arguments: JSON.stringify(args ?? {}) },
      });
      return {
        content: [{ type: "text", text: result }],
        isError: result.startsWith("Error") || result.includes('"status":"error"'),
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: String((e as Error).message) }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.log("[mcp] local server started (stdio)");
}
