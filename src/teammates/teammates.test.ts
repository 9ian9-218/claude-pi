import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockOpenAI } from "../../tests/helpers/mock-openai.ts";
import { resetClient, type ChatMessage } from "../client.ts";
import { setTeamsDir, TEAM_LEAD_NAME } from "./constants.ts";
import { setGitRoot } from "../worktree.ts";
import { setTasksDir } from "../tasks.ts";
import { setSkillsDir } from "../skill-load.ts";
import { installBuiltinHooks } from "../hook.ts";
import {
  writeToMailbox,
  readMailbox,
  sendPlainMessage,
  clearMailbox,
} from "./mailbox.ts";
import { createTeam, ensureTeammateForSpawn } from "./team-helpers.ts";
import { formatTeammateMessages, isStructuredProtocolMessage } from "./message-types.ts";
import { pollOnce, consumePendingInjections, clearPollerQueues } from "./poller.ts";
import { spawnTeammate, requestTeammateShutdown, isTeammateActive, clearActiveTeammates } from "./spawn.ts";

const originalEnv = { ...process.env };
let dir: string;
let mock: MockOpenAI;

beforeEach(async () => {
  process.env = { ...originalEnv };
  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_MODEL = "gpt-test";
  resetClient();
  mock = await MockOpenAI.create();
  process.env.OPENAI_BASE_URL = mock.baseUrl;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pi-team-"));
  setTeamsDir(dir);
  clearPollerQueues();
  clearActiveTeammates();
  installBuiltinHooks();
});

afterEach(async () => {
  process.env = { ...originalEnv };
  await mock.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("mailbox（S10）", () => {
  it("写读/未读标记/清空", async () => {
    await sendPlainMessage({
      fromAgent: "worker-1",
      toAgent: TEAM_LEAD_NAME,
      text: "任务完成",
      teamName: "t1",
    });
    const msgs = readMailbox(TEAM_LEAD_NAME, "t1");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].from).toBe("worker-1");
    expect(msgs[0].text).toBe("任务完成");
    expect(msgs[0].read).toBe(false);
    expect(msgs[0].timestamp).toBeDefined();
    clearMailbox(TEAM_LEAD_NAME, "t1");
    expect(readMailbox(TEAM_LEAD_NAME, "t1")).toEqual([]);
  });

  it("并发写不损坏（文件锁）", async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        writeToMailbox(TEAM_LEAD_NAME, { from: `w${i}`, text: `msg${i}` }, "t1"),
      ),
    );
    const msgs = readMailbox(TEAM_LEAD_NAME, "t1");
    expect(msgs).toHaveLength(10);
  });
});

describe("team-helpers / message-types（S10）", () => {
  it("createTeam + ensureTeammateForSpawn 分配颜色", () => {
    createTeam("alpha", TEAM_LEAD_NAME);
    const m1 = ensureTeammateForSpawn("alpha", "worker-a");
    const m2 = ensureTeammateForSpawn("alpha", "worker-b");
    expect(m1.color).toBe("green"); // lead 占 blue，队友依次分配
    // 颜色不重复
    expect(m2.color).not.toBe(m1.color);
    expect(() => ensureTeammateForSpawn("nope", "x")).toThrow();
  });

  it("structured 判定与 teammate-message 包装", () => {
    expect(isStructuredProtocolMessage('{"type":"idle_notification","agentName":"a"}')).toBe(true);
    expect(isStructuredProtocolMessage("plain text")).toBe(false);
    const formatted = formatTeammateMessages([
      { from: "worker-1", text: "hi", color: "green" },
      { from: "worker-2", text: '{"type":"idle_notification"}' },
    ]);
    expect(formatted).toContain('<teammate-message teammate_id="worker-1" color="green">');
    expect(formatted).toContain("hi");
    expect(formatted).not.toContain("idle_notification");
  });
});

describe("poller（S10）", () => {
  it("pollOnce 将普通消息注入注入队列", async () => {
    createTeam("beta", TEAM_LEAD_NAME);
    await sendPlainMessage({
      fromAgent: "worker-1",
      toAgent: TEAM_LEAD_NAME,
      text: "进度报告",
      teamName: "beta",
      color: "green",
    });
    await pollOnce("beta");
    const injections = consumePendingInjections();
    expect(injections).toHaveLength(1);
    expect(injections[0]).toContain("<teammate-message");
    expect(injections[0]).toContain("进度报告");
    // 已读：再次 poll 不重复注入
    await pollOnce("beta");
    expect(consumePendingInjections()).toEqual([]);
  });
});

describe("spawn 端到端（S10）", () => {
  it("spawn → 工作 → 报告进 lead 邮箱 → shutdown 终止", async () => {
    createTeam("gamma", TEAM_LEAD_NAME);
    // teammate 的 agentLoop 请求（每轮 WORK 一次）→ 返回内容
    mock.always(() => ({ kind: "sse", chunks: [{ content: "teammate 完成工作", finishReason: "stop" }] }));

    const result = spawnTeammate({
      name: "tester",
      role: "test-runner",
      prompt: "跑测试并报告",
      teamName: "gamma",
    });
    expect(result).toContain("spawned");

    // 等待 teammate 报告到达 lead 邮箱
    await vi.waitFor(
      () => {
        const msgs = readMailbox(TEAM_LEAD_NAME, "gamma");
        expect(msgs.some((m) => m.from === "tester" && String(m.text).includes("teammate 完成工作"))).toBe(true);
      },
      { timeout: 15000, interval: 100 },
    );

    expect(isTeammateActive("gamma", "tester")).toBe(true);

    // shutdown
    const shutdown = await requestTeammateShutdown("tester", "gamma");
    expect(shutdown).toContain("Shutdown request");
    await vi.waitFor(
      () => {
        expect(isTeammateActive("gamma", "tester")).toBe(false);
      },
      { timeout: 10000, interval: 100 },
    );
  }, 40000);

  it("重复 spawn 同一名字被拒", () => {
    createTeam("delta", TEAM_LEAD_NAME);
    const r1 = spawnTeammate({ name: "dup", role: "r", prompt: "p", teamName: "delta" });
    expect(r1).toContain("spawned");
    const r2 = spawnTeammate({ name: "dup", role: "r", prompt: "p", teamName: "delta" });
    expect(r2).toContain("already active");
  });

  it("spawn 到不存在团队报错", () => {
    expect(spawnTeammate({ name: "x", role: "r", prompt: "p", teamName: "missing" })).toContain(
      "team 'missing' not found",
    );
  });
});
