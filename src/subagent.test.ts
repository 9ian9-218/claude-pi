import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MockOpenAI } from "../tests/helpers/mock-openai.ts";
import { installMockModels } from "../tests/helpers/test-client.ts";
import { resetClient, type ChatMessage } from "./client.ts";
import { agentLoop } from "./agent-loop.ts";
import { runQuery } from "./query-pipeline.ts";
import { LoopOptions } from "./loop-options.ts";
import { getOpenaiTools, spawnSubagent, executeToolCall } from "./tool.ts";
import { getAgentContext, isSubagent, runWithAgentContext, resetAgentContext } from "./teammates/context.ts";
import { AgentProfile, profileToContext } from "./agent-profile.ts";
import { resetAskUserImpl } from "./permission-sync.ts";import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager, setSessionRoot } from "./session-manager.ts";
import { clearAgentRuns, listAgentRuns } from "./agent-registry.ts";

let mock: MockOpenAI;

beforeEach(async () => {
  resetClient();
  mock = await MockOpenAI.create();
  installMockModels(mock.baseUrl);
});

afterEach(async () => {
  resetClient();
  await mock.close();
});

describe("subagent 工具集限制（S9）", () => {
  it("getOpenaiTools(true) 排除 subagent 禁用工具", () => {
    const names = getOpenaiTools(true).map((t) => t.function.name);
    expect(names).toContain("read_file");
    expect(names).toContain("run_bash");
    expect(names).not.toContain("todo_write");
    expect(names).not.toContain("subagent_task");
    expect(names).not.toContain("create_task");
    expect(names).not.toContain("claim_task");
    expect(names).not.toContain("complete_task");
  });

  it("主 agent 不受限制", () => {
    const names = getOpenaiTools(false).map((t) => t.function.name);
    expect(names).toContain("subagent_task");
    expect(names).toContain("create_task");
  });
});

describe("spawnSubagent（S9）", () => {
  it("子 agent 完成任务返回摘要文本", async () => {
    mock.always(() => ({ kind: "sse", chunks: [{ content: "子任务结果摘要", finishReason: "stop" }] }));
    const result = await spawnSubagent("调研模块结构");
    expect(result).toBe("子任务结果摘要");
    // 子 agent 请求体：system(subagent) + user(任务描述)，无禁用工具
    const req = mock.requests[0];
    expect(req.messages[0].role).toBe("system");
    expect(String(req.messages[1].content)).toContain("调研模块结构");
    const toolNames = (req.tools as Array<{ function: { name: string } }>).map((t) => t.function.name);
    expect(toolNames).not.toContain("subagent_task");
  });

  it("子 agent 无最终内容时返回停止提示", async () => {
    // 持续返回 tool_calls（未知工具）→ 30 轮后无最终内容
    mock.always(() => ({
      kind: "sse",
      chunks: [
        {
          toolCalls: [{ index: 0, id: "c1", name: "ghost_tool", arguments: "{}" }],
          finishReason: "tool_calls",
        },
      ],
    }));
    const result = await spawnSubagent("跑不动的任务", { maxTurns: 2 });
    expect(result).toContain("Subagent stopped");
  });

  it("父 loop 中通过 subagent_task 工具调用子 agent", async () => {
    // 父请求：subagent_task 调用 → 子请求：返回摘要 → 父继续
    mock.push(() => ({
      kind: "sse",
      chunks: [
        {
          toolCalls: [
            {
              index: 0,
              id: "call_sa",
              name: "subagent_task",
              arguments: '{"description":"帮我读 README"}',
            },
          ],
          finishReason: "tool_calls",
        },
      ],
    }));
    mock.push(() => ({ kind: "sse", chunks: [{ content: "子代理报告", finishReason: "stop" }] }));
    mock.push(() => ({ kind: "sse", chunks: [{ content: "父代理总结", finishReason: "stop" }] }));
    const messages: ChatMessage[] = [{ role: "user", content: "委派任务" }];
    await agentLoop(messages, { loopOptions: new LoopOptions({ quietOutput: true }) });
    // 子代理结果作为 tool 结果进入父上下文
    expect(String(messages[3].content)).toContain("子代理报告");
    expect(messages[4].role).toBe("assistant");
    expect(messages[4].content).toBe("父代理总结");
  });
});

describe("subagent 身份（Agent Profile）", () => {
  afterEach(() => {
    resetAskUserImpl();
  });

  it("spawnSubagent 在 loop 内写入 role=subagent（权限可同步冒泡）", async () => {
    // 默认 responder：空回复即终止回合
    mock.push(() => ({ kind: "json", content: "ok" }));
    const result = await spawnSubagent("say hi");
    expect(result).toBeTruthy();
    // After spawn, context should restore (not leak subagent role into parent)
    expect(isSubagent(getAgentContext())).toBe(false);
  });

  it("LoopOptions.subagent 走受限工具面", async () => {
    const names = getOpenaiTools(true).map((t) => t.function.name);
    expect(names).not.toContain("spawn_teammate");
    expect(names).not.toContain("create_team");
  });
});

describe("subagent 角色门禁（executeToolCall 第二道闸）", () => {
  it("subagent 身份下直接调用受限工具被拒", async () => {
    const profile = AgentProfile.subagent({ agentName: "s1", agentId: "s1" });
    await runWithAgentContext(profileToContext(profile), async () => {
      const out = await executeToolCall({
        function: { name: "create_team", arguments: '{ "name": "x" }' },
      });
      expect(out).toContain("not available to subagents");
    });
  });

  it("lead 身份下不受门禁影响", async () => {
    resetAgentContext();
    const out = await executeToolCall({
      function: { name: "no_such_tool", arguments: "{}" },
    });
    expect(out).toContain("Unknown tool");
  });
});


describe("子 agent 子会话落盘与血缘（可观测性）", () => {
  let root: string;
  let parent: SessionManager;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pi-subagent-"));
    setSessionRoot(root);
    clearAgentRuns();
    parent = SessionManager.create(process.cwd());
  });

  afterEach(() => {
    setSessionRoot("");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("delegate 落盘独立子会话，父会话登记血缘，注册表可查", async () => {
    mock.always(() => ({
      kind: "sse",
      chunks: [{ content: "模块结构调研完成", finishReason: "stop" }],
    }));
    const parentFile = parent.getSessionFile();
    expect(parentFile).toBeTruthy();

    const out = await executeToolCall(
      {
        id: "call-delegate-1",
        function: {
          name: "delegate",
          arguments: JSON.stringify({ role: "scout", task: "调研模块结构" }),
        },
      },
      undefined,
      { session: parent },
    );
    expect(out).toContain("模块结构调研完成");

    // 父会话登记血缘：/tree 与 /export 可见
    const customs = parent.getEntries().filter((e) => e.type === "custom");
    const start = customs.find(
      (e) => (e as { customType?: string }).customType === "subagent",
    ) as unknown as { data: Record<string, unknown> } | undefined;
    expect(start).toBeTruthy();
    expect(start!.data["role"]).toBe("scout");
    const childFile = String(start!.data["sessionFile"]);
    expect(fs.existsSync(childFile)).toBe(true);

    // 子会话文件 header 指向父会话
    const child = SessionManager.open(childFile);
    expect(child.getHeader().parentSession).toBe(parentFile);

    // 运行注册表可查（面板与 /agents 的数据源）
    const runs = listAgentRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0].role).toBe("scout");
    expect(runs[0].status).toBe("done");
    expect(runs[0].sessionFile).toBe(childFile);
    expect(runs[0].result).toContain("模块结构调研完成");
    // 用量聚合字段：子会话 entry → 注册表（面板/footer 的数据源）
    expect(runs[0].usage).toBeDefined();
    expect(typeof runs[0].usage!.cost).toBe("number");
    // 首轮缓存读写：mock 会返回 usage，故该字段应被记录（真实环境 R>0 即命中父前缀）
    expect(runs[0].firstTurnCache).toBeDefined();
    // 子会话里确实落了助手回复（可复盘）
    expect(child.getEntries().some((e) => e.type === "message")).toBe(true);
  });

  it("fork 模式：子会话继承父历史，请求沿用父 system 提示（cache 前缀一致）", async () => {
    mock.always(() => ({
      kind: "sse",
      chunks: [{ content: "侦察完成", finishReason: "stop" }],
    }));
    parent.appendMessage({ role: "user", content: "父会话历史：实现登录功能" });
    parent.appendMessage({ role: "assistant", content: "收到，先看代码" });

    await executeToolCall(
      {
        id: "call-fork-1",
        function: {
          name: "delegate",
          arguments: JSON.stringify({ role: "scout", task: "定位登录相关代码" }),
        },
      },
      undefined,
      { session: parent },
    );

    const req = mock.requests[0];
    // 1) system 提示沿用父身份（不是 scout 身份）→ 前缀与父一致，可命中 prompt cache
    const system = String(req.messages[0].content);
    expect(system).toContain("You are a coding agent at");
    expect(system).not.toContain("You are a scout");

    // 2) 父历史进入子请求（fork）
    const all = req.messages.map((m) => String(m.content)).join("\n");
    expect(all).toContain("父会话历史：实现登录功能");

    // 3) 角色契约与任务放在尾部 user 消息（分叉点）
    const last = req.messages[req.messages.length - 1];
    expect(String(last.content)).toContain("[Role Brief — scout]");
    expect(String(last.content)).toContain("定位登录相关代码");

    // 4) 子会话确实是 fork：文件独立、血缘指向父会话、含父历史
    const start = parent
      .getEntries()
      .find((e) => (e as { customType?: string }).customType === "subagent") as unknown as {
      data: Record<string, unknown>;
    };
    const child = SessionManager.open(String(start.data["sessionFile"]));
    expect(child.getSessionFile()).not.toBe(parent.getSessionFile());
    expect(child.getHeader().parentSession).toBe(parent.getSessionFile());
    expect(JSON.stringify(child.getEntries())).toContain("父会话历史：实现登录功能");
  });

  it("子 agent 结束时在父会话追加 subagent_end 记录", async () => {
    mock.always(() => ({
      kind: "sse",
      chunks: [{ content: "验证通过", finishReason: "stop" }],
    }));

    await executeToolCall(
      {
        id: "call-delegate-2",
        function: {
          name: "delegate",
          arguments: JSON.stringify({ role: "verifier", task: "跑一遍单测" }),
        },
      },
      undefined,
      { session: parent },
    );

    const end = parent
      .getEntries()
      .find((e) => (e as { customType?: string }).customType === "subagent_end") as
      | { data?: { status?: string } }
      | undefined;
    expect(end).toBeTruthy();
    expect(end!.data?.status).toBe("done");
  });
});
describe("fork 前缀一致性（prompt cache 复用）", () => {
  let root: string;
  let parent: SessionManager;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pi-prefix-"));
    setSessionRoot(root);
    clearAgentRuns();
    parent = SessionManager.create(process.cwd());
  });

  afterEach(() => {
    setSessionRoot("");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("子 agent 请求 = 父请求（system + tools + 历史）+ 尾部角色简报", async () => {
    // ① 父 agent 决定委派（工具调用）
    mock.push(() => ({
      kind: "sse",
      chunks: [
        {
          toolCalls: [
            {
              index: 0,
              id: "call-delegate-1",
              name: "delegate",
              arguments: JSON.stringify({ role: "scout", task: "定位登录相关代码" }),
            },
          ],
          finishReason: "tool_calls",
        },
      ],
    }));
    // ② 子 agent 返回结果
    mock.push(() => ({
      kind: "sse",
      chunks: [{ content: "定位完成：src/auth.ts:10-40", finishReason: "stop" }],
    }));
    // ③ 父 agent 收尾
    mock.push(() => ({
      kind: "sse",
      chunks: [{ content: "已定位到登录逻辑", finishReason: "stop" }],
    }));

    await runQuery("帮我看一下登录逻辑", {
      session: parent,
      runHooks: false,
      quietOutput: true,
    });

    const parentReq = mock.requests[0];
    const childReq = mock.requests[1];
    expect(parentReq).toBeTruthy();
    expect(childReq).toBeTruthy();

    // 1) system 逐字节一致（fork 子 agent 用父身份构造 system）
    expect(childReq.messages[0]).toEqual(parentReq.messages[0]);

    // 2) 工具面一致：tools 段在最前面，任何差异都会毁掉后面所有缓存
    expect(JSON.stringify(childReq.tools)).toBe(JSON.stringify(parentReq.tools));

    // 3) 历史前缀一致：子请求的前 N 条 == 父请求的全部 N 条
    expect(childReq.messages.slice(0, parentReq.messages.length)).toEqual(parentReq.messages);

    // 4) 分叉点之后只多两条：父的 assistant(tool_call) + 尾部角色简报/任务
    //    （assistant(tool_call) 也会出现在父的下一轮请求里，所以它仍是共享前缀的一部分）
    const extra = childReq.messages.slice(parentReq.messages.length) as Array<{
      role: string;
      content?: unknown;
    }>;
    expect(extra).toHaveLength(2);
    expect(extra[0]?.role).toBe("assistant");
    const tail = String(extra[1]?.content ?? "");
    expect(tail).toContain("[Role Brief — scout]");
    expect(tail).toContain("[Restrictions — 仅本任务有效，由运行时强制执行]");
    expect(tail).toContain("可用工具（白名单，其余一律不可用）");
    expect(tail).toContain("read_file");
    expect(tail).toContain("禁止任何写操作");
    expect(tail).toContain("定位登录相关代码");
  });
});
