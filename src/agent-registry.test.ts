import { describe, it, expect, beforeEach } from "vitest";
import {
  AGENT_RESULT_PREVIEW,
  aggregateAgentUsage,
  MAX_AGENT_RUNS,
  appendAgentText,
  clearAgentRuns,
  findAgentRunByPrefix,
  finishAgentRun,
  getAgentRun,
  listAgentRuns,
  startAgentRun,
  subscribeAgentRuns,
  updateAgentRun,
} from "./agent-registry.ts";

beforeEach(() => {
  clearAgentRuns();
});

describe("agent 运行注册表", () => {
  it("start → update → finish 生命周期可查", () => {
    const run = startAgentRun({
      id: "scout-1",
      role: "scout",
      label: "scout · 调研",
      sessionId: "sess-1",
      sessionFile: "/tmp/sess-1.jsonl",
      parentSessionFile: "/tmp/parent.jsonl",
    });
    expect(run.status).toBe("running");
    expect(run.turns).toBe(0);
    expect(run.toolCalls).toBe(0);

    updateAgentRun("scout-1", { turns: 3, toolCalls: 2, lastTool: "read_file" });
    const mid = getAgentRun("scout-1");
    expect(mid?.turns).toBe(3);
    expect(mid?.lastTool).toBe("read_file");
    expect(mid?.sessionFile).toBe("/tmp/sess-1.jsonl");

    finishAgentRun("scout-1", { status: "done", result: "调研完成" });
    const done = getAgentRun("scout-1");
    expect(done?.status).toBe("done");
    expect(done?.result).toBe("调研完成");
    expect(done?.endedAt).toBeGreaterThan(0);
  });

  it("订阅者收到最新快照", () => {
    const snapshots: number[] = [];
    const off = subscribeAgentRuns((runs) => snapshots.push(runs.length));
    startAgentRun({ id: "a-1", role: "planner", label: "planner" });
    startAgentRun({ id: "a-2", role: "worker", label: "worker" });
    off();
    startAgentRun({ id: "a-3", role: "verifier", label: "verifier" });
    expect(snapshots).toEqual([1, 2]);
  });

  it("流式文本累积并被截断", () => {
    startAgentRun({ id: "a-1", role: "scout", label: "scout" });
    appendAgentText("a-1", "第一段。");
    appendAgentText("a-1", "第二段。");
    expect(getAgentRun("a-1")?.lastText).toBe("第一段。第二段。");
  });

  it("结果与错误按上限截断", () => {
    startAgentRun({ id: "a-1", role: "worker", label: "worker" });
    finishAgentRun("a-1", { status: "failed", error: "x".repeat(AGENT_RESULT_PREVIEW + 50) });
    const run = getAgentRun("a-1");
    expect(run?.status).toBe("failed");
    expect(run?.error?.length).toBe(AGENT_RESULT_PREVIEW + 1);
  });

  it("前缀查找只在唯一命中时返回", () => {
    startAgentRun({ id: "scout-aaaa1111", role: "scout", label: "s1" });
    startAgentRun({ id: "scout-bbbb2222", role: "scout", label: "s2" });
    expect(findAgentRunByPrefix("scout-aaaa")?.id).toBe("scout-aaaa1111");
    expect(findAgentRunByPrefix("scout-")).toBeNull();
    expect(findAgentRunByPrefix("missing")).toBeNull();
  });

  it("超过上限时淘汰最旧的运行", () => {
    for (let i = 0; i < MAX_AGENT_RUNS + 5; i++) {
      startAgentRun({ id: `a-${i}`, role: "worker", label: `w${i}` });
    }
    const runs = listAgentRuns();
    expect(runs).toHaveLength(MAX_AGENT_RUNS);
    expect(runs.find((r) => r.id === "a-0")).toBeUndefined();
    expect(runs.find((r) => r.id === `a-${MAX_AGENT_RUNS + 4}`)).toBeTruthy();
  });
});
describe("子 agent 用量聚合", () => {
  it("汇总各 agent 的 token/成本，并带上数量与在跑数", () => {
    startAgentRun({ id: "s-1", role: "scout", label: "s1" });
    updateAgentRun("s-1", { usage: { input: 100, output: 20, cacheRead: 900, cacheWrite: 10, cost: 0.01 } });
    startAgentRun({ id: "v-1", role: "verifier", label: "v1" });
    updateAgentRun("v-1", { usage: { input: 300, output: 40, cacheRead: 0, cacheWrite: 0, cost: 0.02 } });
    finishAgentRun("v-1", { status: "done", result: "ok" });

    const fleet = aggregateAgentUsage();
    expect(fleet.count).toBe(2);
    expect(fleet.running).toBe(1);
    expect(fleet.usage.input).toBe(400);
    expect(fleet.usage.output).toBe(60);
    expect(fleet.usage.cacheRead).toBe(900);
    expect(fleet.usage.cacheWrite).toBe(10);
    expect(fleet.usage.cost).toBeCloseTo(0.03, 6);
  });

  it("没有 agent 时聚合为零", () => {
    const fleet = aggregateAgentUsage();
    expect(fleet).toEqual({
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
      count: 0,
      running: 0,
    });
  });
});
