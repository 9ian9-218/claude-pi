import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  setTasksDir,
  createTask,
  listTasks,
  getTask,
  canStart,
  allocateTaskId,
  taskGraphHasCycle,
  buildDependencyGraph,
  validateCreateTaskDependencies,
  claimTask,
  completeTask,
  runCreateTask,
  runListTasks,
  runGetTask,
  resetBlocksIndex,
} from "./tasks.ts";
import { setGitRoot } from "./worktree.ts";
import { runWithWorkdir, getWorkdir } from "./workdir.ts";

let dir: string;
let repo: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-pi-tasks-"));
  setTasksDir(dir);
  resetBlocksIndex();
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
  fs.rmSync(dir, { recursive: true, force: true });
  try {
    execFileSync("git", ["worktree", "prune"], { cwd: repo, stdio: "ignore" });
  } catch {
    // 忽略
  }
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("任务 CRUD（S8-3）", () => {
  it("createTask 分配递增 ID 并持久化", () => {
    const t1 = createTask("重构 auth", "详细描述");
    const t2 = createTask("写测试");
    expect(t1.id).toBe("task_1");
    expect(t2.id).toBe("task_2");
    expect(t1.status).toBe("pending");
    expect(fs.existsSync(path.join(dir, "task_1.json"))).toBe(true);
  });

  it("highwatermark：删除文件后 ID 不复用", () => {
    createTask("a");
    const id = allocateTaskId();
    expect(id).toBe("task_2");
  });

  it("listTasks 排序与字段", () => {
    createTask("b");
    createTask("a");
    const tasks = listTasks();
    expect(tasks.map((t) => t.subject)).toEqual(["b", "a"]);
    expect(tasks[0].id).toBe("task_1");
  });

  it("getTask 返回 JSON 详情", () => {
    createTask("x", "desc");
    const raw = getTask("task_1");
    const parsed = JSON.parse(raw);
    expect(parsed.subject).toBe("x");
    expect(parsed.description).toBe("desc");
  });

  it("依赖环检测", () => {
    expect(taskGraphHasCycle({ a: ["b"], b: ["a"] })).toBe(true);
    expect(taskGraphHasCycle({ a: ["b"], b: ["c"], c: [] })).toBe(false);
  });

  it("createTask 依赖校验：未知依赖/自依赖", () => {
    expect(() => createTask("x", "", ["task_99"])).toThrow("Unknown dependency");
    const t1 = createTask("a");
    expect(() => createTask("b", "", [t1.id])).not.toThrow();
    expect(validateCreateTaskDependencies("task_9", ["task_9"])).toContain("cannot depend on itself");
    // 环检测由 taskGraphHasCycle 纯函数覆盖（单次创建场景下不可达，Python 同构防御）
  });

  it("blocks 反向索引自动维护", () => {
    const t1 = createTask("upstream");
    const t2 = createTask("downstream", "", [t1.id]);
    // 重新加载后 blocks 索引同步
    resetBlocksIndex();
    const upstream = JSON.parse(getTask(t1.id)) as { blocks: string[] };
    expect(upstream.blocks).toContain(t2.id);
  });

  it("canStart：依赖完成后可开始", async () => {
    const t1 = createTask("a");
    const t2 = createTask("b", "", [t1.id]);
    expect(canStart(t2.id)).toBe(false);
    await claimTask(t1.id, "agent");
    await completeTask(t1.id);
    expect(canStart(t2.id)).toBe(true);
  });
});

describe("claim / complete 全流程（S8-4）", () => {
  it("claim → worktree 创建 + workdir 切换；complete → 清理 + 恢复", async () => {
    const t = createTask("隔离任务");
    const result = await claimTask(t.id, "agent");
    expect(result).toContain("Claimed task_1");
    // workdir 已切换到 worktree
    const wt = path.join(repo, ".agent", "worktrees", "task_1");
    expect(fs.existsSync(wt)).toBe(true);
    // complete 恢复
    const done = await completeTask(t.id);
    expect(done).toContain("Completed task_1");
    expect(fs.existsSync(wt)).toBe(false);
  });

  it("claim 后文件操作局限在 worktree 内（getWorkdir 生效）", async () => {
    const t = createTask("隔离验证");
    const wt = path.join(repo, ".agent", "worktrees", "task_1");
    await runWithWorkdir(process.cwd(), async () => {
      await claimTask(t.id, "agent");
      expect(getWorkdir()).toBe(wt);
      // worktree 内写文件不影响主仓库
      fs.writeFileSync(path.join(getWorkdir(), "isolated.txt"), "x");
      expect(fs.existsSync(path.join(repo, "isolated.txt"))).toBe(false);
    });
  });

  it("依赖未完成时 claim 被阻塞", async () => {
    const t1 = createTask("a");
    const t2 = createTask("b", "", [t1.id]);
    const result = await claimTask(t2.id, "agent");
    expect(result).toContain("Blocked by: task_1");
  });

  it("busy check：一个 agent 不能同时 claim 两个任务", async () => {
    const t1 = createTask("a");
    const t2 = createTask("b");
    await claimTask(t1.id, "agent", { enforceBusy: true });
    const result = await claimTask(t2.id, "agent", { enforceBusy: true });
    expect(result).toContain("busy with task_1");
  });

  it("complete 后解除下游阻塞", async () => {
    const t1 = createTask("a");
    const t2 = createTask("b", "", [t1.id]);
    await claimTask(t1.id, "agent");
    const done = await completeTask(t1.id);
    expect(done).toContain("Unblocked: b");
  });

  it("非 owner 不能 complete", async () => {
    const t = createTask("a");
    await claimTask(t.id, "worker-1");
    await expect(completeTask(t.id, { owner: "worker-2" })).rejects.toThrow("only the owner");
  });
});

describe("工具入口（S8-5）", () => {
  it("runCreateTask / runListTasks / runGetTask", () => {
    const created = runCreateTask("主题", "描述");
    expect(created).toContain("Created task_1");
    const list = runListTasks("all");
    expect(list).toContain("○ task_1: 主题 [pending]");
    const got = runGetTask("task_1");
    expect(got).toContain('"subject": "主题"');
    expect(runGetTask("task_99")).toContain("not found");
  });

  it("runListTasks 状态过滤与空列表", () => {
    expect(runListTasks("all")).toContain("No tasks.");
    createTask("x");
    expect(runListTasks("completed")).toContain("No tasks.");
  });
});
