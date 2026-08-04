import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MockOpenAI } from "../tests/helpers/mock-openai.ts";
import { installMockModels } from "../tests/helpers/test-client.ts";
import { resetClient, type ChatMessage } from "./client.ts";
import { agentLoop } from "./agent-loop.ts";
import { LoopOptions } from "./loop-options.ts";
import { getOpenaiTools, spawnSubagent } from "./tool.ts";

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
    const result = await spawnSubagent("跑不动的任务");
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
