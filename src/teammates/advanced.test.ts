import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTeamsDir, TEAM_LEAD_NAME } from "./constants.ts";
import { createAgentContext, runWithAgentContext } from "./context.ts";
import { createTeam, getLeaderName } from "./team-helpers.ts";
import { readMailbox, clearMailbox } from "./mailbox.ts";
import {
  processPendingLeadPermissions,
  permissionHookWithBubble,
  setAskUserImpl,
  resetAskUserImpl,
} from "../permission-sync.ts";
import { clearPollerQueues, consumePendingPermissionRequests, pollOnce } from "./poller.ts";
import {
  registerRequest,
  matchResponse,
  getRequest,
  clearProtocolRequests,
} from "./protocol.ts";
import { idlePoll } from "./autonomous.ts";
import { setTasksDir, createTask } from "../tasks.ts";
import type { ChatMessage } from "../client.ts";

let dir: string;
let taskDir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pi-p11-"));
  taskDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pi-p11t-"));
  setTeamsDir(dir);
  setTasksDir(taskDir);
  clearPollerQueues();
  clearProtocolRequests();
  resetAskUserImpl();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(taskDir, { recursive: true, force: true });
});

describe("protocol（S11）", () => {
  it("register/match/get 关联 request_id", () => {
    registerRequest({
      requestId: "req-1",
      type: "shutdown",
      sender: "lead",
      target: "worker",
      payload: "",
      status: "pending",
      createdAt: Date.now(),
    });
    expect(getRequest("req-1")?.status).toBe("pending");
    const matched = matchResponse({ responseType: "shutdown_approved", requestId: "req-1", approved: true });
    expect(matched?.status).toBe("approved");
    // 类型不匹配不关联
    registerRequest({
      requestId: "req-2",
      type: "shutdown",
      sender: "a",
      target: "b",
      payload: "",
      status: "pending",
      createdAt: Date.now(),
    });
    expect(matchResponse({ responseType: "plan_approval_response", requestId: "req-2", approved: true })).toBeNull();
  });
});

describe("权限冒泡（S11）", () => {
  it("teammate 规则命中 → 请求进 lead 邮箱 → Lead 批准 → 放行", async () => {
    createTeam("swarm", TEAM_LEAD_NAME);
    const ctx = createAgentContext({
      teamName: "swarm",
      agentName: "worker-1",
      agentId: "worker-1@swarm",
      color: "green",
      role: "teammate",
    });
    setAskUserImpl(() => ({ decision: "approved", resolvedBy: "leader" }));

    const pending = runWithAgentContext(ctx, () =>
      permissionHookWithBubble({
        name: "run_bash",
        input: { command: "rm -rf build", run_in_background: false },
        id: "call_perm",
      }),
    );

    // lead 邮箱有请求；poller 路由 → 主线程处理
    await vi.waitFor(
      () => {
        const leadMail = readMailbox(getLeaderName("swarm"), "swarm");
        expect(leadMail.some((m) => String(m.text).includes("permission_request"))).toBe(true);
      },
      { timeout: 5000, interval: 50 },
    );
    await pollOnce("swarm");
    await processPendingLeadPermissions("swarm");
    const result = await pending;
    expect(result).toBeNull();

    // 响应已发回 worker 邮箱
    await vi.waitFor(
      () => {
        const workerMail = readMailbox("worker-1", "swarm");
        expect(workerMail.some((m) => String(m.text).includes("permission_response"))).toBe(true);
      },
      { timeout: 5000, interval: 50 },
    );
  });

  it("lead 拒绝 → teammate 收到拒绝消息", async () => {
    createTeam("swarm2", TEAM_LEAD_NAME);
    const ctx = createAgentContext({
      teamName: "swarm2",
      agentName: "worker-2",
      role: "teammate",
    });
    setAskUserImpl(() => ({ decision: "rejected", resolvedBy: "leader", feedback: "不许" }));

    const pending = runWithAgentContext(ctx, () =>
      permissionHookWithBubble({
        name: "write_file",
        input: { path: "../evil", content: "x" },
        id: "call_perm2",
      }),
    );
    await vi.waitFor(
      () => {
        expect(readMailbox(getLeaderName("swarm2"), "swarm2").some((m) => String(m.text).includes("permission_request"))).toBe(true);
      },
      { timeout: 5000, interval: 50 },
    );
    await pollOnce("swarm2");
    await processPendingLeadPermissions("swarm2");
    const result = await pending;
    expect(result).toContain("Permission denied");
  });

  it("独立 lead（无 team）规则命中 → 默认拒绝且含规则原因", async () => {
    const result = await permissionHookWithBubble({
      name: "run_bash",
      input: { command: "rm -rf build", run_in_background: false },
      id: "call_perm3",
    });
    expect(result).toContain("Permission denied");
    expect(result).toContain("Potentially destructive command");
  });

  it("规则未命中直接放行（不冒泡）", async () => {
    const result = await permissionHookWithBubble({
      name: "read_file",
      input: { path: "src/x.ts" },
      id: "call_perm4",
    });
    expect(result).toBeNull();
    expect(consumePendingPermissionRequests()).toEqual([]);
  });
});

describe("autonomous idlePoll（S11）", () => {
  it("看板有可 claim 任务 → auto-claimed + work", async () => {
    createTeam("idle1", TEAM_LEAD_NAME);
    createTask("自动化任务");
    const messages: ChatMessage[] = [];
    const result = await idlePoll({
      agentName: "worker-a",
      teamName: "idle1",
      messages,
      role: "worker",
      isShutdownRequested: () => false,
      pollIntervalMs: 20,
      idleTimeoutMs: 2000,
    });
    expect(result).toBe("work");
    expect(messages.some((m) => String(m.content).includes("<auto-claimed>"))).toBe(true);
  });

  it("shutdown 请求 → shutdown", async () => {
    createTeam("idle2", TEAM_LEAD_NAME);
    const result = await idlePoll({
      agentName: "worker-b",
      teamName: "idle2",
      messages: [],
      role: "worker",
      isShutdownRequested: () => true,
      pollIntervalMs: 20,
      idleTimeoutMs: 2000,
    });
    expect(result).toBe("shutdown");
  });

  it("无任务且无消息 → timeout", async () => {
    createTeam("idle3", TEAM_LEAD_NAME);
    const result = await idlePoll({
      agentName: "worker-c",
      teamName: "idle3",
      messages: [],
      role: "worker",
      isShutdownRequested: () => false,
      pollIntervalMs: 10,
      idleTimeoutMs: 100,
    });
    expect(result).toBe("timeout");
  });
});
