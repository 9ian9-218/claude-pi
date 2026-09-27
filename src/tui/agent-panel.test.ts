import { describe, it, expect, beforeEach } from "vitest";
import { AgentPanelComponent } from "./messages/agent-panel.ts";
import {
  appendAgentText,
  clearAgentRuns,
  finishAgentRun,
  startAgentRun,
  updateAgentRun,
} from "../agent-registry.ts";

function makePanel(): AgentPanelComponent {
  return new AgentPanelComponent();
}

beforeEach(() => {
  clearAgentRuns();
});

describe("子 agent 折叠面板（Ctrl+A）", () => {
  it("没有 agent 时渲染为空（不占行）", () => {
    const panel = makePanel();
    expect(panel.getText()).toBe("");
    panel.dispose();
  });

  it("折叠时显示汇总行与每个 agent 一行", () => {
    const panel = makePanel();
    startAgentRun({ id: "scout-1a2b", role: "scout", label: "scout · 调研模块" });
    updateAgentRun("scout-1a2b", { turns: 2, toolCalls: 3, lastTool: "grep" });
    const text = panel.getText();
    expect(text).toContain("1 个子 agent");
    expect(text).toContain("运行 1");
    expect(text).toContain("Ctrl+A 展开");
    expect(text).toContain("scout-1a2b");
    expect(text).toContain("2 轮 / 3 工具");
    expect(text).toContain("grep");
    panel.dispose();
  });

  it("展开后显示子会话文件与结果，并可再次折叠", () => {
    const panel = makePanel();
    startAgentRun({
      id: "verifier-9f0c",
      role: "verifier",
      label: "verifier · 跑测试",
      sessionFile: "/tmp/sessions/1790_abc.jsonl",
    });
    updateAgentRun("verifier-9f0c", { turns: 1, toolCalls: 1, lastTool: "run_bash" });
    appendAgentText("verifier-9f0c", "正在执行 npm test");
    finishAgentRun("verifier-9f0c", { status: "done", result: "12 passed" });

    panel.toggle();
    expect(panel.isExpanded()).toBe(true);
    const expanded = panel.getText();
    expect(expanded).toContain("Ctrl+A 折叠");
    expect(expanded).toContain("任务: verifier · 跑测试");
    expect(expanded).toContain("1790_abc.jsonl");
    expect(expanded).toContain("12 passed");
    expect(expanded).toContain("正在执行 npm test");

    panel.toggle();
    expect(panel.isExpanded()).toBe(false);
    expect(panel.getText()).not.toContain("1790_abc.jsonl");
    panel.dispose();
  });

  it("失败状态在折叠行可见", () => {
    const panel = makePanel();
    startAgentRun({ id: "worker-x", role: "worker", label: "worker · 改代码" });
    finishAgentRun("worker-x", { status: "failed", error: "30 轮无最终回答" });
    const text = panel.getText();
    expect(text).toContain("失败 1");
    expect(text).toContain("✗");
    panel.dispose();
  });

  it("注册表变化后面板自动刷新", () => {
    const panel = makePanel();
    expect(panel.getText()).toBe("");
    startAgentRun({ id: "planner-1", role: "planner", label: "planner · 出方案" });
    expect(panel.getText()).toContain("planner-1");
    panel.dispose();
    startAgentRun({ id: "planner-2", role: "planner", label: "planner · 第二个" });
    expect(panel.getText()).not.toContain("planner-2");
  });
});
describe("子 agent 面板：用量聚合展示", () => {
  it("折叠行显示成本，展开行显示各分量", () => {
    const panel = makePanel();
    startAgentRun({ id: "worker-cafe0001", role: "worker", label: "worker · 改代码" });
    updateAgentRun("worker-cafe0001", {
      turns: 4,
      toolCalls: 6,
      lastTool: "edit_file",
      usage: { input: 12000, output: 3000, cacheRead: 40000, cacheWrite: 1200, cost: 0.0456 },
    });

    expect(panel.getText()).toContain("$0.0456");

    panel.toggle();
    const expanded = panel.getText();
    expect(expanded).toContain("用量: ↑12k ↓3.0k R40k W1.2k $0.0456");
    panel.dispose();
  });

  it("展开时显示首轮缓存，并标注是否复用父前缀", () => {
    const panel = makePanel();
    startAgentRun({ id: "scout-hit", role: "scout", label: "scout · 命中" });
    updateAgentRun("scout-hit", { firstTurnCache: { cacheRead: 12000, cacheWrite: 0 } });
    startAgentRun({ id: "scout-miss", role: "scout", label: "scout · 未命中" });
    updateAgentRun("scout-miss", { firstTurnCache: { cacheRead: 0, cacheWrite: 12000 } });

    panel.toggle();
    const text = panel.getText();
    expect(text).toContain("首轮缓存: R12k W0（已复用父前缀）");
    expect(text).toContain("首轮缓存: R0 W12k（未命中父前缀）");
    panel.dispose();
  });

  it("没有用量时不显示成本", () => {
    const panel = makePanel();
    startAgentRun({ id: "scout-1", role: "scout", label: "scout" });
    expect(panel.getText()).not.toContain("$");
    panel.dispose();
  });
});
