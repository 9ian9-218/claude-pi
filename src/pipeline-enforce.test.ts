import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isToolBlockedByPreset, isToolAllowedForRole, getOpenaiTools, executeToolCall } from "./tool.ts";
import { createAgentContext, runWithAgentContext, type AgentRole } from "./teammates/context.ts";
import { setTeamMode, resetSettingsCache } from "./settings.ts";

let dir: string;
let prevAgentDir: string | undefined;

const asRole = <T>(role: AgentRole, fn: () => T): T =>
  runWithAgentContext(createAgentContext({ role }), fn);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cpi-preset-"));
  prevAgentDir = process.env["PI_CODING_AGENT_DIR"];
  process.env["PI_CODING_AGENT_DIR"] = dir;
  resetSettingsCache();
});

afterEach(() => {
  if (prevAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
  else process.env["PI_CODING_AGENT_DIR"] = prevAgentDir;
  resetSettingsCache();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("pipeline 预设的强制执行", () => {
  it("开启预设：lead 不能写文件/跑命令（执行闸拒绝并给出替代路径）", async () => {
    setTeamMode("pipeline");
    for (const name of ["write_file", "edit_file", "run_bash"]) {
      expect(isToolBlockedByPreset("lead", name)).toBe(true);
    }
    const res = await asRole("lead", () =>
      executeToolCall({ function: { name: "write_file", arguments: '{"path":"a.txt","content":"x"}' } }),
    );
    const parsed = JSON.parse(res) as { status: string; message: string };
    expect(parsed.status).toBe("error");
    expect(parsed.message).toContain("Pipeline preset is ON");
    expect(parsed.message).toContain("worker"); // 给出该怎么绕道
  });

  it("开启预设：只读工具与 delegate 仍然可用", () => {
    setTeamMode("pipeline");
    for (const name of ["read_file", "grep", "glob", "todo_write", "delegate"]) {
      expect(isToolBlockedByPreset("lead", name)).toBe(false);
      expect(isToolAllowedForRole("lead", name)).toBe(true);
    }
  });

  it("未开启预设（free）：lead 行为与原来一致，可写可跑", () => {
    setTeamMode("free");
    for (const name of ["write_file", "edit_file", "run_bash"]) {
      expect(isToolBlockedByPreset("lead", name)).toBe(false);
      expect(isToolAllowedForRole("lead", name)).toBe(true);
    }
  });

  it("worker / verifier 角色不受预设禁令影响（活儿由它们干）", () => {
    setTeamMode("pipeline");
    expect(isToolBlockedByPreset("worker", "write_file")).toBe(false);
    expect(isToolAllowedForRole("worker", "write_file")).toBe(true);
    expect(isToolBlockedByPreset("verifier", "run_bash")).toBe(false);
    expect(isToolAllowedForRole("verifier", "run_bash")).toBe(true);
    // 只读角色本来就被白名单挡住写
    expect(isToolAllowedForRole("reviewer", "write_file")).toBe(false);
  });

  it("呈现的工具面刻意不变（否则 fork 子 agent 会连 write_file 都看不到）", () => {
    setTeamMode("pipeline");
    const names = getOpenaiTools("lead").map((t) => t.function.name);
    expect(names).toContain("write_file");
    expect(names).toContain("delegate");
  });
});