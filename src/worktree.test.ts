import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withFileLock } from "./file-lock.ts";
import {
  setGitRoot,
  isGitAvailable,
  taskBranchName,
  createTaskWorktree,
  removeTaskWorktree,
  listTaskWorktrees,
  getCurrentWorktreeTaskId,
} from "./worktree.ts";
import { setWorktreeOverride, getWorkdir, runWithWorkdir } from "./workdir.ts";

describe("file-lock（S8-1）", () => {
  it("串行锁：释放后可再次获取", async () => {
    const lockPath = path.join(os.tmpdir(), `claude-pi-lock-${process.pid}.lock`);
    try {
      await withFileLock(lockPath, async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
      await withFileLock(lockPath, async () => {
        expect(true).toBe(true);
      });
    } finally {
      fs.rmSync(lockPath, { force: true });
    }
  });

  it("并发互斥：两个锁等待者串行执行", async () => {
    const lockPath = path.join(os.tmpdir(), `claude-pi-lock2-${process.pid}.lock`);
    try {
      const order: string[] = [];
      await Promise.all([
        withFileLock(lockPath, async () => {
          order.push("first-start");
          await new Promise((r) => setTimeout(r, 50));
          order.push("first-end");
        }),
        withFileLock(lockPath, async () => {
          order.push("second-start");
          order.push("second-end");
        }),
      ]);
      expect(order.indexOf("first-end")).toBeLessThan(order.indexOf("second-start"));
    } finally {
      fs.rmSync(lockPath, { force: true });
    }
  });
});

describe("worktree（S8-2）", () => {
  let repo: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pi-git-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "a.txt"), "hello");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });
    setGitRoot(repo);
  });

  afterEach(() => {
    // 清理残留 worktree（避免临时目录删除失败）
    try {
      execFileSync("git", ["worktree", "prune"], { cwd: repo, stdio: "ignore" });
    } catch {
      // 忽略
    }
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("isGitAvailable / 分支命名 agent/task-<id>", () => {
    expect(isGitAvailable()).toBe(true);
    expect(taskBranchName("task_1")).toBe("agent/task-task_1");
  });

  it("createTaskWorktree 创建隔离目录与分支", () => {
    const wt = createTaskWorktree("task_7");
    expect(wt).not.toBeNull();
    expect(fs.existsSync(path.join(repo, ".agent", "worktrees", "task_7"))).toBe(true);
    expect(listTaskWorktrees()).toEqual(["task_7"]);
    const branch = execFileSync("git", ["branch", "--show-current"], { cwd: wt!, encoding: "utf8" }).trim();
    expect(branch).toBe("agent/task-task_7");
  });

  it("removeTaskWorktree 清理目录与分支", () => {
    const wt = createTaskWorktree("task_8")!;
    expect(fs.existsSync(wt)).toBe(true);
    removeTaskWorktree("task_8");
    expect(fs.existsSync(wt)).toBe(false);
    expect(listTaskWorktrees()).toEqual([]);
  });

  it("getCurrentWorktreeTaskId 识别 worktree 内目录", () => {
    const wt = createTaskWorktree("task_9")!;
    // 模拟 claim 后的 workdir 上下文
    runWithWorkdir(wt, () => {
      expect(getCurrentWorktreeTaskId()).toBe("task_9");
    });
    // 主仓库 workdir 返回 null
    runWithWorkdir(repo, () => {
      expect(getCurrentWorktreeTaskId()).toBeNull();
    });
  });
});

describe("worktree override 集成（S8-4）", () => {
  it("claim 切换 workdir / complete 恢复（模拟 tasks 流程）", async () => {
    await runWithWorkdir(process.cwd(), async () => {
      expect(getWorkdir()).toBe(process.cwd());
      setWorktreeOverride("/wt/dir");
      expect(getWorkdir()).toBe("/wt/dir");
      setWorktreeOverride(null);
      expect(getWorkdir()).toBe(process.cwd());
    });
  });
});

describe("git 不可用降级（S8-2）", () => {
  it("非 git 目录下 createTaskWorktree 返回 null 不抛错", () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pi-nogit-"));
    setGitRoot(plain);
    try {
      expect(isGitAvailable()).toBe(false);
      expect(createTaskWorktree("task_1")).toBeNull();
      removeTaskWorktree("task_1"); // 不抛
      expect(listTaskWorktrees()).toEqual([]);
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});
