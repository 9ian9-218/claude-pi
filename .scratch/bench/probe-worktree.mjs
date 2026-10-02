#!/usr/bin/env node
/**
 * probe-worktree.mjs — 不经模型，直接验证「claim_task 的 worktree 隔离会不会吞掉改动」
 *
 * 跑法：node .scratch/bench/probe-worktree.mjs
 * 在一个临时 git 仓库里走一遍真实调用链：
 *   createTask → claimTask（切 workdir 到 worktree）→ 在 worktree 里改文件 → completeTask
 * 然后看主树里那份改动还在不在。
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../..", "src");

const repo = mkdtempSync(join(tmpdir(), "cpi-wt-probe-"));
const g = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
g("init", "-q");
g("config", "user.email", "probe@example.com");
g("config", "user.name", "probe");
writeFileSync(join(repo, "app.py"), "VALUE = 1\n");
g("add", "-A");
g("commit", "-qm", "baseline");

const { setGitRoot, taskWorktreePath } = await import(join(SRC, "worktree.ts"));
const tasks = await import(join(SRC, "tasks.ts"));
const workdir = await import(join(SRC, "workdir.ts"));

setGitRoot(repo);
tasks.setTasksDir(join(repo, ".agent", "tasks"));
mkdirSync(join(repo, ".agent", "tasks"), { recursive: true });

await workdir.runWithWorkdir(repo, async () => {
  console.log("create:", tasks.runCreateTask("probe: 改 app.py", "", []));
  console.log("claim :", await tasks.claimTask("task_1", "agent"));
  const wt = taskWorktreePath("task_1");
  console.log("claim 后 workdir =", workdir.getWorkdir());
  console.log("worktree 路径   =", wt, existsSync(wt) ? "(存在)" : "(缺失)");

  // 模拟 agent 在「当前有效工作目录」下改文件 —— 路径相对于 workdir 解析
  writeFileSync(join(workdir.getWorkdir(), "app.py"), "VALUE = 2  # fixed\n");
  console.log("worktree 内改动 =", readFileSync(join(wt, "app.py"), "utf8").trim());

  await tasks.completeTask("task_1");
  console.log("complete 后 workdir =", workdir.getWorkdir());
  console.log("worktree 是否还在  =", existsSync(wt));
  const main = readFileSync(join(repo, "app.py"), "utf8").trim();
  console.log("主树 app.py        =", main);
  console.log(main.includes("fixed") ? "结论：改动保留 → 无缺陷" : "结论：改动丢失 → 复现缺陷");
});

rmSync(repo, { recursive: true, force: true });
