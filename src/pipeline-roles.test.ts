import { describe, it, expect } from "vitest";
import { AgentProfile } from "./agent-profile.ts";
import { PIPELINE_ROLES, isPipelineRole, isReadOnlyRole, runWithAgentContext, createAgentContext } from "./teammates/context.ts";
import { isToolAllowedForRole, executeToolCall, getOpenaiTools } from "./tool.ts";
import { DELEGATE_TASK_TOOL } from "./tools/agent-tools.ts";
import { getRoleIdentity } from "./prompt.ts";

describe("Coding Pipeline 5 个固定专职角色编制", () => {
  it("PIPELINE_ROLES 包含 5 个核心角色", () => {
    expect(PIPELINE_ROLES).toEqual(["scout", "planner", "worker", "reviewer", "verifier"]);
    for (const r of PIPELINE_ROLES) {
      expect(isPipelineRole(r)).toBe(true);
    }
    expect(isPipelineRole("lead")).toBe(false);
    expect(isPipelineRole("teammate")).toBe(false);
    expect(isPipelineRole("unknown")).toBe(false);
  });

  it("isReadOnlyRole 正确区分只读角色与可写角色", () => {
    expect(isReadOnlyRole("scout")).toBe(true);
    expect(isReadOnlyRole("planner")).toBe(true);
    expect(isReadOnlyRole("reviewer")).toBe(true);
    expect(isReadOnlyRole("verifier")).toBe(true);
    expect(isReadOnlyRole("worker")).toBe(false);
    expect(isReadOnlyRole("lead")).toBe(false);
    expect(isReadOnlyRole("teammate")).toBe(false);
  });

  it("AgentProfile 工厂方法生成符合预期的专职配置", () => {
    const scout = AgentProfile.scout();
    expect(scout.role).toBe("scout");
    expect(scout.enableMemory).toBe(false);
    expect(scout.useSubagentToolFace).toBe(true);

    const planner = AgentProfile.planner();
    expect(planner.role).toBe("planner");
    expect(planner.enableMemory).toBe(false);

    const worker = AgentProfile.worker();
    expect(worker.role).toBe("worker");
    expect(worker.enableBackground).toBe(true);

    const reviewer = AgentProfile.reviewer();
    expect(reviewer.role).toBe("reviewer");

    const verifier = AgentProfile.verifier();
    expect(verifier.role).toBe("verifier");
  });

  it("getRoleIdentity 注入各自的标准交付物契约", () => {
    const scoutPrompt = getRoleIdentity("scout", "/test/dir");
    expect(scoutPrompt).toContain("## Context Overview");
    expect(scoutPrompt).toContain("## Files Located");
    expect(scoutPrompt).toContain("## Key Code & Interfaces");

    const plannerPrompt = getRoleIdentity("planner", "/test/dir");
    expect(plannerPrompt).toContain("## Goal & Scope");
    expect(plannerPrompt).toContain("## Step-by-Step Plan");
    expect(plannerPrompt).toContain("## Acceptance Criteria");

    const workerPrompt = getRoleIdentity("worker", "/test/dir");
    expect(workerPrompt).toContain("## Completed Work");
    expect(workerPrompt).toContain("## Files Changed");

    const reviewerPrompt = getRoleIdentity("reviewer", "/test/dir");
    expect(reviewerPrompt).toContain("## Review Summary");
    expect(reviewerPrompt).toContain("## Findings");
    expect(reviewerPrompt).toContain("## Verdict");

    const verifierPrompt = getRoleIdentity("verifier", "/test/dir");
    expect(verifierPrompt).toContain("## Verification Summary");
    expect(verifierPrompt).toContain("## Commands Executed");
    expect(verifierPrompt).toContain("## Verdict");
  });
});

describe("Pipeline 角色工具白名单与执行门禁", () => {
  it("工具白名单矩阵正确限制各角色可用工具", () => {
    // scout: 只读定位 + bash
    expect(isToolAllowedForRole("scout", "read_file")).toBe(true);
    expect(isToolAllowedForRole("scout", "grep")).toBe(true);
    expect(isToolAllowedForRole("scout", "write_file")).toBe(false);
    expect(isToolAllowedForRole("scout", "edit_file")).toBe(false);

    // planner: 纯文件探索，无 bash，严禁写
    expect(isToolAllowedForRole("planner", "read_file")).toBe(true);
    expect(isToolAllowedForRole("planner", "grep")).toBe(true);
    expect(isToolAllowedForRole("planner", "run_bash")).toBe(false);
    expect(isToolAllowedForRole("planner", "write_file")).toBe(false);

    // worker: 全能（可读、可写、可执行）
    expect(isToolAllowedForRole("worker", "read_file")).toBe(true);
    expect(isToolAllowedForRole("worker", "edit_file")).toBe(true);
    expect(isToolAllowedForRole("worker", "write_file")).toBe(true);
    expect(isToolAllowedForRole("worker", "run_bash")).toBe(true);

    // reviewer: 审查，严禁改写
    expect(isToolAllowedForRole("reviewer", "read_file")).toBe(true);
    expect(isToolAllowedForRole("reviewer", "write_file")).toBe(false);
    expect(isToolAllowedForRole("reviewer", "edit_file")).toBe(false);

    // verifier: 动态测试，允许 bash，严禁改写业务代码
    expect(isToolAllowedForRole("verifier", "read_file")).toBe(true);
    expect(isToolAllowedForRole("verifier", "run_bash")).toBe(true);
    expect(isToolAllowedForRole("verifier", "write_file")).toBe(false);
    expect(isToolAllowedForRole("verifier", "edit_file")).toBe(false);
  });

  it("getOpenaiTools 按角色返回过滤后的工具列表", () => {
    const plannerTools = getOpenaiTools("planner").map((t) => t.function.name);
    expect(plannerTools).toContain("read_file");
    expect(plannerTools).toContain("grep");
    expect(plannerTools).not.toContain("run_bash");
    expect(plannerTools).not.toContain("write_file");
    expect(plannerTools).not.toContain("edit_file");

    const workerTools = getOpenaiTools("worker").map((t) => t.function.name);
    expect(workerTools).toContain("read_file");
    expect(workerTools).toContain("edit_file");
    expect(workerTools).toContain("write_file");
    expect(workerTools).toContain("run_bash");

    // 自由组队与 lead 拥有完整工具
    const leadTools = getOpenaiTools("lead").map((t) => t.function.name);
    expect(leadTools).toContain("create_team");
    expect(leadTools).toContain("spawn_teammate");
    expect(leadTools).toContain("delegate");
  });

  it("executeToolCall 执行闸硬拦截越权操作", async () => {
    // 1. Planner 试图写文件 -> 拦截
    const plannerCtx = createAgentContext({ role: "planner", agentName: "planner-1" });
    const plannerWriteResult = await runWithAgentContext(plannerCtx, async () => {
      return executeToolCall({
        id: "call-1",
        function: { name: "write_file", arguments: JSON.stringify({ path: "test.txt", content: "hello" }) },
      });
    });
    expect(plannerWriteResult).toContain("Role 'planner' is not allowed to use tool 'write_file'");

    // 2. Reviewer 试图修改文件 -> 拦截
    const reviewerCtx = createAgentContext({ role: "reviewer", agentName: "reviewer-1" });
    const reviewerEditResult = await runWithAgentContext(reviewerCtx, async () => {
      return executeToolCall({
        id: "call-2",
        function: { name: "edit_file", arguments: JSON.stringify({ path: "test.txt", edits: [] }) },
      });
    });
    expect(reviewerEditResult).toContain("Role 'reviewer' is not allowed to use tool 'edit_file'");

    // 3. Verifier 试图写文件 -> 拦截
    const verifierCtx = createAgentContext({ role: "verifier", agentName: "verifier-1" });
    const verifierWriteResult = await runWithAgentContext(verifierCtx, async () => {
      return executeToolCall({
        id: "call-3",
        function: { name: "write_file", arguments: JSON.stringify({ path: "test.txt", content: "x" }) },
      });
    });
    expect(verifierWriteResult).toContain("Role 'verifier' is not allowed to use tool 'write_file'");

    // 4. Scout 试图调用没有授权的工具 -> 拦截
    const scoutCtx = createAgentContext({ role: "scout", agentName: "scout-1" });
    const scoutCreateTeamResult = await runWithAgentContext(scoutCtx, async () => {
      return executeToolCall({
        id: "call-4",
        function: { name: "create_team", arguments: JSON.stringify({ name: "my-team" }) },
      });
    });
    expect(scoutCreateTeamResult).toContain("Role 'scout' is not allowed to use tool 'create_team'");
  });
});

describe("delegate 工具与派发接口", () => {
  it("DELEGATE_TASK_TOOL 结构定义完整", () => {
    expect(DELEGATE_TASK_TOOL.name).toBe("delegate");
    expect(DELEGATE_TASK_TOOL.description).toContain("scout");
    expect(DELEGATE_TASK_TOOL.description).toContain("planner");
    expect(DELEGATE_TASK_TOOL.description).toContain("worker");
    expect(DELEGATE_TASK_TOOL.description).toContain("reviewer");
    expect(DELEGATE_TASK_TOOL.description).toContain("verifier");
    const schema = DELEGATE_TASK_TOOL.parameters as any;
    expect(schema.properties.role.enum).toEqual(["scout", "planner", "worker", "reviewer", "verifier"]);
    expect(schema.required).toEqual(["role", "task"]);
  });
});