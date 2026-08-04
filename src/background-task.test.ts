import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  looksLikePrompt,
  isSlowOperation,
  shouldRunBackground,
  runBashWithExitCode,
  startBackgroundTask,
  killBgTask,
  setStallConfig,
  restoreStallConfig,
} from "./background-task.ts";
import {
  consumePendingNotifications,
  clearNotifications,
  hasPendingNotifications,
} from "./message-queue.ts";
import { runWithWorkdir } from "./workdir.ts";

let ws: string;

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pi-bg-"));
  clearNotifications();
});

afterEach(async () => {
  fs.rmSync(ws, { recursive: true, force: true });
  restoreStallConfig();
});

describe("looksLikePrompt / isSlowOperation（S6）", () => {
  it("识别交互等待模式", () => {
    expect(looksLikePrompt("Proceed? (y/n)")).toBe(true);
    expect(looksLikePrompt("Are you sure you want to continue?")).toBe(true);
    expect(looksLikePrompt("normal output line")).toBe(false);
  });

  it("慢操作关键词识别", () => {
    expect(isSlowOperation("run_bash", { command: "npm install" })).toBe(true);
    expect(isSlowOperation("run_bash", { command: "make build" })).toBe(true);
    expect(isSlowOperation("run_bash", { command: "echo hi" })).toBe(false);
    expect(isSlowOperation("read_file", { path: "a" })).toBe(false);
  });

  it("shouldRunBackground：显式 flag 优先于启发式", () => {
    expect(shouldRunBackground("run_bash", { command: "echo hi", run_in_background: true })).toBe(true);
    expect(shouldRunBackground("run_bash", { command: "npm install", run_in_background: false })).toBe(false);
    expect(shouldRunBackground("run_bash", { command: "pytest" })).toBe(true);
  });
});

describe("runBashWithExitCode（S6）", () => {
  it("执行命令返回输出与退出码", async () => {
    const [out, code] = await runBashWithExitCode("echo hello");
    expect(out).toContain("hello");
    expect(code).toBe(0);
  });

  it("失败命令返回非零退出码", async () => {
    const [out, code] = await runBashWithExitCode("exit 3");
    expect(out).toBe("(no output)");
    expect(code).toBe(3);
  });

  it("输出截断 50000 字符", async () => {
    const [out] = await runBashWithExitCode("head -c 60000 /dev/zero | tr '\\0' 'a'");
    expect(out.length).toBe(50000);
  });
});

describe("startBackgroundTask（S6）", () => {
  it("后台任务完成 → 完成通知入队（含 status completed 与输出预览）", async () => {
    const bgId = startBackgroundTask(
      { id: "call_1", function: { name: "run_bash", arguments: '{"command":"echo bg-done"}' } },
      { command: "echo bg-done" },
    );
    expect(bgId).toMatch(/^bg_\d{4}$/);
    await vi.waitFor(() => {
      expect(hasPendingNotifications()).toBe(true);
    }, { timeout: 10000, interval: 50 });
    const [msg] = consumePendingNotifications();
    expect(msg).toContain("<task_id>" + bgId);
    expect(msg).toContain("<status>completed</status>");
    expect(msg).toContain("bg-done");
    expect(msg).toContain("<tool_use_id>call_1</tool_use_id>");
  });

  it("killBgTask 终止运行中的任务", async () => {
    const bgId = startBackgroundTask(
      { id: "call_2", function: { name: "run_bash", arguments: '{"command":"sleep 100"}' } },
      { command: "sleep 100" },
    );
    await vi.waitFor(() => {
      const result = killBgTask(bgId);
      expect(result).toContain("Killed background task");
    }, { timeout: 5000, interval: 50 });
  });

  it("killBgTask 对不存在任务返回错误", () => {
    expect(killBgTask("bg_9999")).toContain("no running task");
  });
});

describe("stall 看门狗（S6）", () => {
  it("交互 prompt 模式触发 stall 通知（one-shot）", async () => {
    setStallConfig({ checkIntervalS: 0.1, thresholdS: 0.3, maxWatchdogS: 60 });
    const bgId = startBackgroundTask(
      { id: "call_3", function: { name: "run_bash", arguments: '{"command":"printf \\"(y/n)? \\" && sleep 5"}' } },
      { command: 'printf "(y/n)? " && sleep 5' },
    );
    await vi.waitFor(
      () => {
        const msgs = consumePendingNotifications();
        expect(msgs.some((m) => m.includes("waiting for interactive input"))).toBe(true);
      },
      { timeout: 8000, interval: 100 },
    );
    // one-shot：不重复通知（等待额外时间验证无第二条）
    await new Promise((r) => setTimeout(r, 1000));
    const rest = consumePendingNotifications();
    expect(rest.filter((m) => m.includes("waiting for interactive input"))).toHaveLength(0);
    // 清理后台进程
    killBgTask(bgId);
  });
});
