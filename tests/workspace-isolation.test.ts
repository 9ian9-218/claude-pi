import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { setGitRoot, taskWorktreePath, preserveWorkspaceArtifact } from "../src/worktree.ts";
import { setTasksDir, createTask, claimTask, completeTask, integrateTask, loadTask, listTasks } from "../src/tasks.ts";
import { runWithWorkdir, runWithCurrentWorkdir, getWorkdir, getWorkspaceBinding, setWorkspaceBinding } from "../src/workdir.ts";
import { createWorkerWorkspace, validateWorkspace, requireWritableWorkspace, restoreAgentWorkspace, finishWorkspace, assertWorkspaceQuiescent } from "../src/workspaces.ts";
import { withRepositoryLock } from "../src/repository-lock.ts";
import { applyFileTransaction, recoverFileTransactions } from "../src/file-transactions.ts";
import { runWithAgentContext, createAgentContext, getAgentContext, setAgentContext, resetAgentContext } from "../src/teammates/context.ts";
import { executeToolCallResult } from "../src/tools/runtime.ts";
import { shellInvocation } from "../src/sandbox.ts";
import { runProcess, cancelWorkspaceProcesses } from "../src/process-runner.ts";
import { idlePoll } from "../src/teammates/autonomous.ts";
import { setTeamsDir, TEAM_LEAD_NAME } from "../src/teammates/constants.ts";
import { createTeam } from "../src/teammates/team-helpers.ts";
import { MockOpenAI } from "./helpers/mock-openai.ts";
import { installMockModels } from "./helpers/test-client.ts";
import { resetClient } from "../src/client.ts";
import { spawnSubagent } from "../src/tools/agent-tools.ts";
import { SessionManager } from "../src/session-manager.ts";

let root: string;
const sourceRoot = path.resolve(import.meta.dirname, "..");
const moduleUrl = (name: string) => JSON.stringify(pathToFileURL(path.join(sourceRoot, "src", name)).href);
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cpi-workspace-isolation-"));
  git("init", "-q", "-b", "main"); git("config", "user.name", "test"); git("config", "user.email", "test@example.invalid");
  fs.writeFileSync(path.join(root, ".gitignore"), ".agent/\n.task_outputs/\n.transcripts/\n");
  fs.writeFileSync(path.join(root, "code.txt"), "base\n"); fs.writeFileSync(path.join(root, "other.txt"), "other\n");
  git("add", "."); git("commit", "-qm", "base");
  setGitRoot(root); setTasksDir(path.join(root, ".agent", "tasks"));
  setTeamsDir(path.join(root, ".agent", "teams"));
});
afterEach(() => { resetAgentContext(); fs.rmSync(root, { recursive: true, force: true }); });

async function child(code: string): Promise<{ code: number | null; signal: string | null; output: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { cwd: sourceRoot, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; proc.stdout.on("data", b => { output += b; }); proc.stderr.on("data", b => { output += b; });
    proc.on("error", reject); proc.on("close", (code, signal) => resolve({ code, signal, output }));
  });
}
function taskSetup() { return `import {setGitRoot} from ${moduleUrl("worktree.ts")}; import {setTasksDir,createTask,claimTask} from ${moduleUrl("tasks.ts")}; setGitRoot(${JSON.stringify(root)});setTasksDir(${JSON.stringify(path.join(root, ".agent", "tasks"))});`; }
function txSetup() { return `import {runWithWorkdir} from ${moduleUrl("workdir.ts")}; import {applyFileTransaction} from ${moduleUrl("file-transactions.ts")};`; }

describe("cross-process workspace isolation", () => {
  it("creates unique task IDs across independent processes", async () => {
    const runs = await Promise.all([0, 1, 2].map(n => child(`${taskSetup()} for(let i=0;i<8;i++) await createTask('process-${n}-'+i);`)));
    runs.forEach(r => expect(r.code, r.output).toBe(0));
    const tasks = listTasks(); expect(tasks).toHaveLength(24); expect(new Set(tasks.map(t => t.id)).size).toBe(24);
    expect(new Set(tasks.map(t => t.subject)).size).toBe(24);
  }, 20000);

  it("allows only one process to claim a task", async () => {
    const task = await createTask("exclusive");
    const runs = await Promise.all(["a", "b"].map(owner => child(`${taskSetup()} console.log(await claimTask(${JSON.stringify(task.id)},${JSON.stringify(owner)}));`)));
    runs.forEach(r => expect(r.code, r.output).toBe(0));
    expect(runs.filter(r => r.output.includes("Claimed"))).toHaveLength(1);
    const saved = loadTask(task.id); expect(saved.status).toBe("in_progress"); expect(saved.binding?.baseSha).toBe(git("rev-parse", "HEAD"));
  }, 15000);

  it("does not mark a task claimed when isolation fails", async () => {
    const task = await createTask("must isolate");
    fs.mkdirSync(taskWorktreePath(task.id), { recursive: true });
    await expect(claimTask(task.id)).rejects.toThrow("does not match task");
    expect(loadTask(task.id)).toMatchObject({ status: "pending", owner: null });
    expect(fs.readFileSync(path.join(root, "code.txt"), "utf8")).toBe("base\n");
  });

  it("rejects unbound worker writes including local MCP aliases", async () => {
    await runWithAgentContext(createAgentContext({ role: "worker", agentId: "unbound" }), () => runWithWorkdir(root, async () => {
      for (const name of ["write_file", "mcp__local__write_file"]) {
        const result = await executeToolCallResult({ function: { name, arguments: JSON.stringify({ path: "code.txt", content: "bad" }) } });
        expect(result.status).toBe("error"); expect(result.output).toContain("isolated workspace");
      }
    }));
    expect(fs.readFileSync(path.join(root, "code.txt"), "utf8")).toBe("base\n");
  });

  it("preserves bindings across work rounds and restores after a dead owner", async () => {
    const task = await createTask("restart");
    const run = await child(`${taskSetup()} await claimTask(${JSON.stringify(task.id)},'resume-agent');`); expect(run.code, run.output).toBe(0);
    await runWithAgentContext(createAgentContext({ role: "teammate", agentId: "resume-agent" }), () => runWithWorkdir(root, async () => {
      await restoreAgentWorkspace(); const binding = getWorkspaceBinding()!;
      expect(binding.ownerPid).toBe(process.pid); expect(getWorkdir()).toBe(taskWorktreePath(task.id));
      await runWithCurrentWorkdir(async () => { expect(requireWritableWorkspace()?.id).toBe(binding.id); });
      await runWithCurrentWorkdir(async () => { expect(getWorkdir()).toBe(binding.worktreePath); });
      await applyFileTransaction([{ path: "code.txt", data: "resumed\n" }]);
      expect(fs.readFileSync(path.join(root, "code.txt"), "utf8")).toBe("base\n");
      await completeTask(task.id, { owner: "resume-agent" }); expect(getWorkspaceBinding()).toBeUndefined(); expect(getWorkdir()).toBe(root);
    }));
  });

  it("rejects old generations and redirected workspace paths", async () => {
    const binding = await createWorkerWorkspace(root, "generation-worker");
    const record = JSON.parse(fs.readFileSync(binding.recordPath, "utf8")); record.generation = "new-generation"; fs.writeFileSync(binding.recordPath, JSON.stringify(record));
    expect(() => validateWorkspace(binding)).toThrow("stale");
  });

  it("does not take a workspace away from another live process", async () => {
    const binding = await createWorkerWorkspace(root, "live-owner");
    const run = await child(`import {runWithWorkdir} from ${moduleUrl("workdir.ts")};import {runWithAgentContext,createAgentContext} from ${moduleUrl("teammates/context.ts")};import {restoreAgentWorkspace} from ${moduleUrl("workspaces.ts")};try{await runWithAgentContext(createAgentContext({role:'teammate',agentId:'live-owner'}),()=>runWithWorkdir(${JSON.stringify(root)},()=>restoreAgentWorkspace()));}catch(e){console.log(e.message)}`);
    expect(run.code, run.output).toBe(0); expect(run.output).toContain("another live cpi process"); expect(validateWorkspace(binding).generation).toBe(binding.generation);
  });

  it("recovers abandoned preparation before creating a new claim", async () => {
    const task = await createTask("interrupted setup");
    fs.writeFileSync(path.join(root, ".agent", "tasks", `${task.id}.json`), JSON.stringify({ ...task, status: "preparing", owner: "dead-owner", preparingPid: 99999999 }));
    expect(await claimTask(task.id, "new-owner")).toContain("Claimed"); expect(loadTask(task.id).owner).toBe("new-owner");
  });

  it("uses the runtime identity for idle claims and keeps it for the next round", async () => {
    createTeam("isolation-team", TEAM_LEAD_NAME); const task = await createTask("idle work");
    await runWithAgentContext(createAgentContext({ role: "teammate", agentName: "member", agentId: "member@isolation-team", teamName: "isolation-team" }), () => runWithWorkdir(root, async () => {
      expect(await idlePoll({ agentName: "member", teamName: "isolation-team", messages: [], isShutdownRequested: () => false, pollIntervalMs: 1, idleTimeoutMs: 1 })).toBe("work");
      expect(loadTask(task.id).owner).toBe("member@isolation-team");
      await runWithCurrentWorkdir(() => applyFileTransaction([{ path: "code.txt", data: "idle worker\n" }]));
      expect(fs.readFileSync(path.join(getWorkdir(), "code.txt"), "utf8")).toBe("idle worker\n"); expect(fs.readFileSync(path.join(root, "code.txt"), "utf8")).toBe("base\n");
    }));
  });

  it("blocks parent delivery until its child workers finish", async () => {
    const task = await createTask("parent task");
    await runWithAgentContext(createAgentContext({ role: "teammate", agentId: "parent" }), () => runWithWorkdir(root, async () => {
      await claimTask(task.id, "parent"); const binding = getWorkspaceBinding()!;
      const child = await createWorkerWorkspace(binding.worktreePath, "unfinished-child");
      await expect(completeTask(task.id)).rejects.toThrow("unfinished child worker"); expect(loadTask(task.id).status).toBe("in_progress");
      finishWorkspace(child, "review"); await completeTask(task.id); expect(loadTask(task.id).status).toBe("completed");
    }));
  });

  it("does not let Git metadata be edited through a directory alias", async () => {
    fs.symlinkSync(path.join(root, ".git"), path.join(root, "metadata-alias"));
    const original = fs.readFileSync(path.join(root, ".git", "config"));
    await expect(runWithWorkdir(root, () => applyFileTransaction([{ path: "metadata-alias/config", data: "bad" }]))).rejects.toThrow("control metadata");
    expect(fs.readFileSync(path.join(root, ".git", "config"))).toEqual(original);
  });

  it("keeps the new task's binding when an older reviewed task is integrated", async () => {
    const first = await createTask("first"), second = await createTask("second");
    await runWithAgentContext(createAgentContext({ role: "teammate", agentId: "two-tasks" }), () => runWithWorkdir(root, async () => {
      await claimTask(first.id, "two-tasks"); await applyFileTransaction([{ path: "code.txt", data: "first change\n" }]); await completeTask(first.id);
      await claimTask(second.id, "two-tasks"); const binding = getWorkspaceBinding()!;
      await runWithAgentContext(createAgentContext({ role: "lead", agentId: "coordinator" }), () => integrateTask(first.id));
      expect(getWorkdir()).toBe(binding.worktreePath); expect(getWorkspaceBinding()?.id).toBe(binding.id);
      await applyFileTransaction([{ path: "other.txt", data: "second change\n" }]);
      expect(fs.readFileSync(path.join(root, "other.txt"), "utf8")).toBe("other\n");
    }));
  });

  it("serializes a main-workspace edit with artifact integration", async () => {
    const binding = await createWorkerWorkspace(root, "edit-race");
    fs.writeFileSync(path.join(binding.worktreePath, "code.txt"), "worker\n");
    const artifact = preserveWorkspaceArtifact(binding.worktreePath, binding.taskId, binding.baseSha, root); finishWorkspace(binding, "review");
    const expectedHash = (await import("../src/checkpoints.ts")).fileHash(fs.readFileSync(path.join(root, "code.txt")));
    const runs = await Promise.all([
      child(`${txSetup()} try{await runWithWorkdir(${JSON.stringify(root)},()=>applyFileTransaction([{path:'code.txt',data:'editor\\n',expectedHash:${JSON.stringify(expectedHash)}}]));console.log('APPLIED')}catch(e){console.log('CONFLICT '+e.message)}`),
      child(`import {integrateTaskArtifact} from ${moduleUrl("worktree.ts")};try{await integrateTaskArtifact(${JSON.stringify(artifact)});console.log('APPLIED')}catch(e){console.log('CONFLICT '+e.message)}`),
    ]);
    expect(runs.filter(r => r.output.includes("APPLIED"))).toHaveLength(1); expect(runs.filter(r => r.output.includes("CONFLICT"))).toHaveLength(1);
  }, 15000);

  it("rejects a worktree replaced with a link to the main workspace", async () => {
    const binding = await createWorkerWorkspace(root, "redirected"); fs.renameSync(binding.worktreePath, `${binding.worktreePath}-saved`); fs.symlinkSync(root, binding.worktreePath);
    expect(() => validateWorkspace(binding)).toThrow("redirected");
  });

  it("does not guess that unverified processes have stopped", async () => {
    const binding = await createWorkerWorkspace(root, "unknown-process"); const dir = path.join(binding.worktreePath, ".agent", "processes"); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "unknown.json"), JSON.stringify({ id: "unknown", ownerPid: 99999999, childPid: process.pid, status: "running" }));
    expect(() => finishWorkspace(binding, "review")).toThrow("unverified process"); expect(validateWorkspace(binding).status).toBe("active");
  });

  it("updates the lead's team while preserving its session identity", () => {
    runWithAgentContext(createAgentContext({ role: "lead", agentId: "session:stable" }), () => {
      setAgentContext(createAgentContext({ role: "lead", teamName: "new-team" }));
      expect(getAgentContext()).toMatchObject({ teamName: "new-team", agentId: "session:stable" });
    });
  });

  it("runs a worker through the model/tool loop and integrates its snapshot diff", async () => {
    const mock = await MockOpenAI.create(); installMockModels(mock.baseUrl);
    fs.writeFileSync(path.join(root, "code.txt"), "parent dirty\n");
    const session = SessionManager.create(root, path.join(root, ".agent", "test-sessions"));
    try {
      mock.push(() => ({ kind: "sse", chunks: [{ toolCalls: [{ index: 0, id: "read", name: "read_file", arguments: '{"path":"code.txt"}' }], finishReason: "tool_calls" }] }));
      mock.push(() => ({ kind: "sse", chunks: [{ toolCalls: [{ index: 0, id: "write", name: "write_file", arguments: '{"path":"code.txt","content":"worker result\\n"}' }], finishReason: "tool_calls" }] }));
      mock.push(() => ({ kind: "sse", chunks: [{ content: "done", finishReason: "stop" }] }));
      const index = git("diff", "--cached", "--binary");
      expect(await runWithWorkdir(root, () => spawnSubagent("update code.txt", { role: "worker", parentSession: session }))).toBe("done");
      expect(JSON.stringify(mock.requests[1].messages)).toContain("parent dirty"); expect(fs.readFileSync(path.join(root, "code.txt"), "utf8")).toBe("worker result\n");
      expect(git("diff", "--cached", "--binary")).toBe(index); expect(session.getEntries().some(e => e.type === "custom" && e.customType === "worker_artifact")).toBe(true);
    } finally { resetClient(); await mock.close(); }
  });

  it("snapshots staged, unstaged, new binary and deleted files without altering the index", async () => {
    fs.writeFileSync(path.join(root, "code.txt"), "staged\n"); git("add", "code.txt"); fs.writeFileSync(path.join(root, "code.txt"), "parent dirty\n");
    fs.writeFileSync(path.join(root, "new.bin"), Buffer.from([0, 255, 17])); fs.unlinkSync(path.join(root, "other.txt"));
    fs.writeFileSync(path.join(root, ".env"), "SECRET=do-not-copy"); const index = git("diff", "--cached", "--binary"); const head = git("rev-parse", "HEAD");
    const binding = await createWorkerWorkspace(root, "snapshot-worker");
    expect(fs.readFileSync(path.join(binding.worktreePath, "code.txt"), "utf8")).toBe("parent dirty\n");
    expect(fs.readFileSync(path.join(binding.worktreePath, "new.bin"))).toEqual(Buffer.from([0, 255, 17]));
    expect(fs.existsSync(path.join(binding.worktreePath, "other.txt"))).toBe(false); expect(fs.existsSync(path.join(binding.worktreePath, ".env"))).toBe(false);
    expect(git("diff", "--cached", "--binary")).toBe(index); expect(git("rev-parse", "HEAD")).toBe(head);
  });

  it("isolates competing workers and serializes cross-process integration", async () => {
    fs.writeFileSync(path.join(root, "code.txt"), "parent dirty\n");
    const a = await createWorkerWorkspace(root, "worker-a"), b = await createWorkerWorkspace(root, "worker-b");
    const artifacts = [];
    for (const [binding, text] of [[a, "A\n"], [b, "B\n"]] as const) {
      await runWithAgentContext(createAgentContext({ role: "worker", agentId: binding.agentId }), () => runWithWorkdir(binding.worktreePath, async () => {
        setWorkspaceBinding(binding); await applyFileTransaction([{ path: "code.txt", data: text }]);
      }));
      artifacts.push(preserveWorkspaceArtifact(binding.worktreePath, binding.taskId, binding.baseSha, root)); finishWorkspace(binding, "review");
    }
    expect(fs.readFileSync(path.join(root, "code.txt"), "utf8")).toBe("parent dirty\n");
    const runs = await Promise.all(artifacts.map(artifact => child(`import {integrateTaskArtifact} from ${moduleUrl("worktree.ts")}; try{await integrateTaskArtifact(${JSON.stringify(artifact)});console.log('INTEGRATED')}catch(e){console.log('CONFLICT '+e.message)}`)));
    runs.forEach(r => expect(r.code, r.output).toBe(0)); expect(runs.filter(r => r.output.includes("INTEGRATED"))).toHaveLength(1); expect(runs.filter(r => r.output.includes("CONFLICT"))).toHaveLength(1);
    expect(["A\n", "B\n"]).toContain(fs.readFileSync(path.join(root, "code.txt"), "utf8"));
    expect(fs.existsSync(a.worktreePath)).toBe(true); expect(fs.existsSync(b.worktreePath)).toBe(true);
  }, 15000);

  it("recovers a process killed after the first file write", async () => {
    const run = await child(`${txSetup()} await runWithWorkdir(${JSON.stringify(root)},()=>applyFileTransaction([{path:'code.txt',data:'changed'},{path:'other.txt',data:'changed too'}],{afterApply(i){if(i===0)process.kill(process.pid,'SIGKILL')}}));`);
    expect(run.signal).toBe("SIGKILL"); expect(fs.readFileSync(path.join(root, "code.txt"), "utf8")).toBe("changed");
    await withRepositoryLock(root, () => recoverFileTransactions(root));
    expect(fs.readFileSync(path.join(root, "code.txt"), "utf8")).toBe("base\n"); expect(fs.readFileSync(path.join(root, "other.txt"), "utf8")).toBe("other\n");
  }, 15000);

  it("blocks recovery and later writes when the user changed interrupted files", async () => {
    const run = await child(`${txSetup()} await runWithWorkdir(${JSON.stringify(root)},()=>applyFileTransaction([{path:'code.txt',data:'changed'},{path:'other.txt',data:'changed too'}],{afterApply(i){if(i===0)process.kill(process.pid,'SIGKILL')}}));`); expect(run.signal).toBe("SIGKILL");
    fs.writeFileSync(path.join(root, "other.txt"), "user change\n");
    await expect(withRepositoryLock(root, () => recoverFileTransactions(root))).rejects.toThrow("Recovery conflict");
    await expect(runWithWorkdir(root, () => applyFileTransaction([{ path: "third.txt", data: "no" }]))).rejects.toThrow("Recovery conflict");
    expect(fs.readFileSync(path.join(root, "code.txt"), "utf8")).toBe("changed"); expect(fs.existsSync(path.join(root, "third.txt"))).toBe(false);
  }, 15000);

  it("restores the current file when failure occurs after applying it", async () => {
    const originalMode = fs.statSync(path.join(root, "code.txt")).mode & 0o777;
    await expect(runWithWorkdir(root, () => applyFileTransaction([{ path: "code.txt", data: "changed", mode: 0o755 }], { afterApply() { throw new Error("failed after chmod"); } }))).rejects.toThrow("failed after chmod");
    expect(fs.readFileSync(path.join(root, "code.txt"), "utf8")).toBe("base\n"); expect(fs.statSync(path.join(root, "code.txt")).mode & 0o777).toBe(originalMode);
  });

  it("blocks delivery while a tracked process runs, then cancels and waits", async () => {
    const binding = await createWorkerWorkspace(root, "process-worker");
    await runWithAgentContext(createAgentContext({ role: "worker", agentId: binding.agentId }), () => runWithWorkdir(binding.worktreePath, async () => {
      setWorkspaceBinding(binding); let spawned!: () => void; const ready = new Promise<void>(r => { spawned = r; });
      const running = runProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], { cwd: binding.worktreePath, onSpawn: spawned });
      await ready; expect(() => assertWorkspaceQuiescent(binding.worktreePath)).toThrow("running or unverified process");
      expect(() => finishWorkspace(binding, "review")).toThrow("running or unverified process");
      await cancelWorkspaceProcesses(binding.worktreePath); expect((await running).status).toBe("cancelled"); expect(() => assertWorkspaceQuiescent(binding.worktreePath)).not.toThrow();
    }));
  });

  it("requires a writable sandbox for owned shell and verification paths", async () => {
    const binding = await createWorkerWorkspace(root, "sandbox-worker");
    await runWithAgentContext(createAgentContext({ role: "worker", agentId: binding.agentId }), () => runWithWorkdir(binding.worktreePath, async () => {
      setWorkspaceBinding(binding); const invocation = shellInvocation(`printf bad > '${path.join(root, "code.txt")}'`, binding.worktreePath);
      expect(invocation.executable).toMatch(/bwrap$/); expect(invocation.args).toContain("--unshare-pid"); expect(invocation.args).toContain("--bind");
      const result = await runProcess(invocation.executable, invocation.args, { cwd: binding.worktreePath, env: invocation.env });
      expect(fs.readFileSync(path.join(root, "code.txt"), "utf8")).toBe("base\n");
      if (result.status === "success") expect(fs.readFileSync(path.join(binding.worktreePath, "code.txt"), "utf8")).toBe("base\n");
    }));
  });
});
