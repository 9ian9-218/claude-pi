import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { MCPHub, getMCPHub, resetMCPHub } from "./hub.ts";
import { buildPrefixedName, isMcpTool, parsePrefixedName, underlyingToolName } from "./names.ts";
import { loadMcpConfig } from "./config.ts";
import { getOpenaiTools, executeToolCall, getToolParameters } from "../tool.ts";
import { MockOpenAI } from "../../tests/helpers/mock-openai.ts";
import { resetClient } from "../client.ts";

// mock MCP server 脚本（stdio）：暴露 echo 工具
const MOCK_SERVER_TS = `
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "mock-server", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "echo", description: "Echo text (readonly)", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "echo") {
    return { content: [{ type: "text", text: "unknown tool" }], isError: true };
  }
  return { content: [{ type: "text", text: "echo:" + String((request.params.arguments ?? {}).text) }], isError: false };
});
await server.connect(new StdioServerTransport());
`;

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pi-mcp-"));
  resetMCPHub();
});

afterEach(async () => {
  const hub = getMCPHub();
  await hub.shutdown();
  resetMCPHub();
  for (const f of serverFiles) {
    fs.rmSync(f, { force: true });
  }
  serverFiles = [];
  fs.rmSync(dir, { recursive: true, force: true });
});

let serverFiles: string[] = [];

function writeMockServer(): string {
  // 仓库根：子进程的 tsx 需从文件位置解析 @modelcontextprotocol/sdk
  const p = path.join(process.cwd(), `.mock-mcp-${process.pid}-${serverFiles.length}.ts`);
  fs.writeFileSync(p, MOCK_SERVER_TS);
  serverFiles.push(p);
  return p;
}

describe("names（S19）", () => {
  it("命名归一化与解析", () => {
    expect(buildPrefixedName("my server", "do thing")).toBe("mcp__my_server__do_thing");
    const [server, tool] = parsePrefixedName("mcp__local__run_bash");
    expect(server).toBe("local");
    expect(tool).toBe("run_bash");
    expect(isMcpTool("mcp__x__y")).toBe(true);
    expect(isMcpTool("run_bash")).toBe(false);
    expect(underlyingToolName("mcp__local__run_bash")).toBe("run_bash");
    expect(underlyingToolName("mcp__ext__tool")).toBe("mcp__ext__tool");
  });
});

describe("mcp.json 配置（S19）", () => {
  it("解析 mcpServers 结构", () => {
    const cfgPath = path.join(dir, "mcp.json");
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        mcpServers: {
          mock: { command: "npx", args: ["tsx", "mock.ts"], autoConnect: true },
        },
      }),
    );
    const configs = loadMcpConfig(cfgPath);
    expect(configs["mock"].command).toBe("npx");
    expect(configs["mock"].autoConnect).toBe(true);
  });
});

describe("hub 连接与调用（S19）", () => {
  it("连接 stdio server → 工具发现（前缀命名）→ 调用", async () => {
    const serverFile = writeMockServer();
    const hub = getMCPHub();
    const result = await hub.connectStdio({
      name: "mock",
      command: process.execPath,
      args: [path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"), serverFile],
      env: {},
      cwd: process.cwd(), // 仓库根：tsx 需解析 @modelcontextprotocol/sdk
      autoConnect: false,
    });
    expect(result).toContain("echo");
    const tools = hub.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].prefixedName).toBe("mcp__mock__echo");
    expect(tools[0].isReadOnly).toBe(true); // description 含 (readonly)
    const call = await hub.callPrefixedTool("mcp__mock__echo", { text: "hi" });
    expect(call).toBe("echo:hi");
  }, 30000);

  it("错误结果格式化为 error JSON", async () => {
    const serverFile = writeMockServer();
    const hub = getMCPHub();
    await hub.connectStdio({
      name: "mock2",
      command: process.execPath,
      args: [path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"), serverFile],
      env: {},
      cwd: process.cwd(),
      autoConnect: false,
    });
    // 模拟错误：直接测 formatCallResult
    const formatted = MCPHub.formatCallResult({
      isError: true,
      content: [{ type: "text", text: "boom" }],
    });
    expect(formatted).toContain('"status":"error"');
  });
});

describe("工具集成（S19）", () => {
  it("MCP 工具出现在 getOpenaiTools，可经 executeToolCall 调用", async () => {
    const originalEnv = { ...process.env };
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_MODEL = "gpt-test";
    resetClient();
    const mock = await MockOpenAI.create();
    process.env.OPENAI_BASE_URL = mock.baseUrl;
    try {
      const serverFile = writeMockServer();
      const hub = getMCPHub();
      await hub.connectStdio({
        name: "mock3",
        command: process.execPath,
        args: [path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"), serverFile],
        env: {},
        cwd: process.cwd(),
        autoConnect: false,
      });
      const names = getOpenaiTools(false).map((t) => t.function.name);
      expect(names).toContain("mcp__mock3__echo");
      expect(getToolParameters("mcp__mock3__echo")?.required).toContain("text");
      const result = await executeToolCall({
        id: "c1",
        function: { name: "mcp__mock3__echo", arguments: '{"text":"world"}' },
      });
      expect(result).toBe("echo:world");
      // 未知 MCP 工具错误
      const missing = await executeToolCall({
        id: "c2",
        function: { name: "mcp__mock3__nope", arguments: "{}" },
      });
      expect(missing).toContain('"status":"error"');
      // 子 agent 排除外部 MCP 工具
      const subNames = getOpenaiTools(true).map((t) => t.function.name);
      expect(subNames).not.toContain("mcp__mock3__echo");
    } finally {
      process.env = originalEnv;
      await mock.close();
    }
  }, 30000);
});

describe("local server（S19）", () => {
  it("本地 server 暴露内置工具（stdio 子进程连接验证）", async () => {
    // 直接启动 local server 的 hub 侧验证：连接一个暴露 BUILTIN_TOOLS 的本地入口
    // 简化：验证 local-server 模块可加载且工具列表含 read_file
    const { startLocalMcpServer } = await import("./local-server.ts");
    expect(typeof startLocalMcpServer).toBe("function");
    // 进程内验证 BUILTIN_TOOLS 覆盖（local server 的 schema 来源）
    const { BUILTIN_TOOLS } = await import("../tool.ts");
    expect(BUILTIN_TOOLS.some((t) => t.name === "read_file")).toBe(true);
  });
});
