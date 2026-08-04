import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  assembleSystemPrompt,
  getSystemPrompt,
  updateContext,
  AGENT_IDENTITY,
  SUBAGENT_IDENTITY,
  MEMORY_SECTION_EMPTY,
} from "./prompt.ts";

// 捕获日志以便断言缓存命中行为
const logs: string[] = [];
const originalLog = console.log;
beforeEach(() => {
  logs.length = 0;
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
});

afterEach(() => {
  console.log = originalLog;
});

describe("assembleSystemPrompt", () => {
  it("主 agent：identity 含 workspace，含 task_planning/background/teams/mcp 与 memory 空段", () => {
    const context = {
      skill_catalog: "",
      workspace: "/tmp/ws",
      memories: "",
      enabled_tools: [] as string[],
      mcp_servers: [] as string[],
      mcp_tool_count: 0,
    };
    const prompt = assembleSystemPrompt(context, { isSubagent: false });
    expect(prompt).toContain(AGENT_IDENTITY.replace("{workspace}", "/tmp/ws"));
    expect(prompt).toContain("## Plan and resolve");
    expect(prompt).toContain("## Background tasks");
    expect(prompt).toContain("## Agent teams");
    expect(prompt).toContain("## MCP tools");
    expect(prompt).toContain(MEMORY_SECTION_EMPTY);
    expect(prompt).not.toContain(SUBAGENT_IDENTITY);
  });

  it("子 agent：只有 subagent_identity，无 memory/planning 段", () => {
    const context = { skill_catalog: "", workspace: "/tmp/ws", memories: "" };
    const prompt = assembleSystemPrompt(context, { isSubagent: true });
    expect(prompt).toContain(SUBAGENT_IDENTITY.replace("{workspace}", "/tmp/ws"));
    expect(prompt).not.toContain("## Plan and resolve");
    expect(prompt).not.toContain(MEMORY_SECTION_EMPTY);
  });

  it("skill_catalog 与 memories 段按 context 注入", () => {
    const context = {
      skill_catalog: "Skills available:\n- test-skill",
      workspace: "/tmp/ws",
      memories: "memories index here",
      enabled_tools: [] as string[],
      mcp_servers: [] as string[],
      mcp_tool_count: 0,
    };
    const prompt = assembleSystemPrompt(context, { isSubagent: false });
    expect(prompt).toContain("Skills available:\n- test-skill");
    expect(prompt).toContain("Memories available:\nmemories index here");
  });

  it("mcp_servers 非空时附加服务器列表段", () => {
    const context = {
      skill_catalog: "",
      workspace: "/tmp/ws",
      memories: "",
      enabled_tools: [] as string[],
      mcp_servers: ["server-a"],
      mcp_tool_count: 3,
    };
    const prompt = assembleSystemPrompt(context, { isSubagent: false });
    expect(prompt).toContain("Connected MCP servers: server-a (3 tools discovered).");
  });
});

describe("getSystemPrompt 缓存", () => {
  it("context 不变时命中缓存并打印 [cache hit]", () => {
    const context = { skill_catalog: "", workspace: "/tmp/ws", memories: "" };
    const first = getSystemPrompt(context, { isSubagent: false });
    const second = getSystemPrompt(context, { isSubagent: false });
    expect(second).toBe(first);
    expect(logs.some((l) => l.includes("[cache hit]"))).toBe(true);
  });

  it("context 变化时重新组装并打印 [assembled]", () => {
    const c1 = { skill_catalog: "", workspace: "/tmp/ws", memories: "" };
    const c2 = { ...c1, workspace: "/tmp/ws2" };
    const p1 = getSystemPrompt(c1, { isSubagent: false });
    const p2 = getSystemPrompt(c2, { isSubagent: false });
    expect(p2).not.toBe(p1);
    expect(p2).toContain("/tmp/ws2");
    expect(logs.some((l) => l.includes("[assembled]"))).toBe(true);
  });
});

describe("updateContext", () => {
  it("返回 workspace/skill 目录/空 memory 结构（后续工单接入）", () => {
    const ctx = updateContext({}, []);
    expect(ctx.workspace).toBe(process.cwd());
    expect(ctx.skill_catalog).toContain("Skills available:");
    expect(ctx.memories).toBe("");
    expect(Array.isArray(ctx.enabled_tools)).toBe(true);
  });
});
