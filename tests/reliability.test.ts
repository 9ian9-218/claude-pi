import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync, execFile } from "node:child_process";
import { runProcess } from "../src/process-runner.ts";
import { executeToolCallResult, ROLE_TOOL_ALLOWLIST, TOOL_MAP } from "../src/tools/runtime.ts";
import { runWithWorkdir } from "../src/workdir.ts";
import { createAgentContext, runWithAgentContext, resetAgentContext } from "../src/teammates/context.ts";
import { installBuiltinHooks, registerHook, triggerHooks } from "../src/hook.ts";
import { readOnlyInvocation, childEnvironment } from "../src/sandbox.ts";
import { fileHash, restoreFileCheckpoint } from "../src/checkpoints.ts";
import { setGitRoot, taskWorktreePath, removeTaskWorktree, preserveTaskArtifact } from "../src/worktree.ts";
import { setTasksDir, createTask, claimTask, completeTask, integrateTask, getTask, canStart, resetBlocksIndex } from "../src/tasks.ts";
import { TaskBudget, BudgetExceeded, runWithBudget, currentBudget } from "../src/task-budget.ts";
import { agentLoopDetailed } from "../src/agent-loop.ts";
import { LoopOptions } from "../src/loop-options.ts";
import { SessionManager } from "../src/session-manager.ts";
import { resetClient, completeText } from "../src/client.ts";
import { MockOpenAI } from "./helpers/mock-openai.ts";
import { installMockModels, createTestAgentDir } from "./helpers/test-client.ts";
import { inspectRepository, instructionText } from "../src/repository-context.ts";
import { trustProjectCode, isProjectCodeTrusted } from "../src/workspace-trust.ts";
import { ExtensionManager } from "../src/extensions/loader.ts";
import { buildTool, registerExtensionTool } from "../src/tool.ts";

let ws: string;
beforeEach(() => { ws = fs.mkdtempSync(path.join(os.tmpdir(), "cpi-reliability-")); resetAgentContext(); installBuiltinHooks(); resetBlocksIndex(); });
afterEach(() => { resetClient(); vi.unstubAllEnvs(); fs.rmSync(ws, { recursive: true, force: true }); });
const call = (name: string, args: Record<string, unknown>, ctx?: Parameters<typeof executeToolCallResult>[2]) => executeToolCallResult({ id: "probe", function: { name, arguments: JSON.stringify(args) } }, args, ctx);
const quiet = new LoopOptions({ quietOutput: true, skipMemoryStopHook: true, enableBackground: false });
function initRepo() {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: ws, stdio: "pipe" }).toString();
  git("init", "-q", "-b", "main"); git("config", "user.name", "test"); git("config", "user.email", "test@example.invalid");
  fs.writeFileSync(path.join(ws, "code.txt"), "baseline\n"); fs.writeFileSync(path.join(ws, ".gitignore"), ".agent/\n.task_outputs/\n");
  git("add", "."); git("commit", "-qm", "baseline"); setGitRoot(ws); setTasksDir(path.join(ws, ".agent", "tasks"));
  return git;
}

describe("real process failures, cancellation and output bounds", () => {
  it("distinguishes empty-output success and failure, preserving exit code", () => runWithWorkdir(ws, async () => {
    const good = await call("run_bash", { command: "true", run_in_background: false }); const bad = await call("run_bash", { command: "false", run_in_background: false });
    expect(good.status).toBe("success"); expect(good.exitCode).toBe(0); expect(bad.status).toBe("error"); expect(bad.exitCode).toBe(1);
  }));
  it("does not block the event loop during a slow command", async () => {
    let elapsed = Infinity; const start = Date.now(); const timer = setTimeout(() => { elapsed = Date.now() - start; }, 25);
    await runProcess("/bin/bash", ["-c", "sleep .25"], { cwd: ws }); clearTimeout(timer); expect(elapsed).toBeLessThan(200);
  });
  it("times out and terminates a TERM-ignoring grandchild", async () => {
    const childCode = `process.on('SIGTERM', () => {}); require('fs').writeFileSync(${JSON.stringify(path.join(ws, "pid"))}, String(process.pid)); setInterval(() => {}, 1000)`;
    const result = await runProcess(process.execPath, ["-e", `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], {stdio:'inherit'}); setInterval(() => {}, 1000)`], { cwd: ws, timeoutMs: 350 });
    expect(result.status).toBe("timeout"); const pid = Number(fs.readFileSync(path.join(ws, "pid"), "utf8"));
    await vi.waitFor(() => { let running = false; try { const state = fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.[0]; running = state !== "Z"; } catch {} expect(running).toBe(false); }, { timeout: 3000 });
  });
  it("accepts AbortSignal and stops a running process promptly", async () => {
    const controller = new AbortController(); setTimeout(() => controller.abort(), 80); const started = Date.now();
    const result = await runProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: ws, signal: controller.signal });
    expect(result.status).toBe("cancelled"); expect(Date.now() - started).toBeLessThan(1500);
  });
  it("streams megabytes to disk while keeping a bounded preview", async () => {
    const result = await runProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(2_000_000))"], { cwd: ws, outputLimitBytes: 1024 });
    expect(result.status).toBe("success"); expect(result.stdout?.length).toBe(1024); expect(result.truncated).toBe(true);
    expect(fs.statSync(result.artifactRefs![0]).size).toBe(2_000_000);
  });
});

describe("mandatory capabilities and error semantics", () => {
  it("blocks reviewer shell writes and the local MCP alias", () => runWithWorkdir(ws, () => runWithAgentContext(createAgentContext({ role: "reviewer", agentName: "review" }), async () => {
    for (const name of ["run_bash", "mcp__local__run_bash"]) expect((await call(name, { command: "printf marker > marker.txt", run_in_background: false })).status).toBe("error");
    expect(fs.existsSync(path.join(ws, "marker.txt"))).toBe(false);
    expect((await call("mcp__local__write_file", { path: "marker.txt", content: "x" })).status).toBe("error");
  })));
  it("allows safe git queries but rejects helpers, expansions and redirects", () => {
    initRepo(); expect(readOnlyInvocation("git diff --stat", ws).args).toContain("--no-ext-diff");
    for (const command of ["git diff --output=marker.txt", "git show --ext-diff", "git status; touch marker", "git status $(touch marker)", "git log -- ../outside"]) expect(() => readOnlyInvocation(command, ws)).toThrow();
  });
  it("strips credentials and execution injection variables from child environments", () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "test-secret"); vi.stubEnv("NODE_OPTIONS", "--require=malicious"); vi.stubEnv("GIT_CONFIG_COUNT", "1");
    expect(childEnvironment().DEEPSEEK_API_KEY).toBeUndefined(); expect(childEnvironment().NODE_OPTIONS).toBeUndefined(); expect(childEnvironment().GIT_CONFIG_COUNT).toBeUndefined();
  });
  it("control hook exceptions and argument mutation fail closed", () => runWithWorkdir(ws, async () => {
    let dispose = registerHook("PreToolUse", () => { throw new Error("policy offline"); });
    expect((await call("write_file", { path: "a", content: "x" })).status).toBe("error"); dispose();
    dispose = registerHook("PreToolUse", block => { block.input.path = "changed"; });
    expect((await call("write_file", { path: "a", content: "x" })).status).toBe("error"); dispose(); expect(fs.existsSync(path.join(ws, "a"))).toBe(false);
  }));
  it("validates nested tool arguments even without validation hooks", () => runWithWorkdir(ws, async () => {
    expect((await call("apply_patch", { edits: [{ path: "a", old_text: 4, new_text: "x" }] })).status).toBe("error");
    expect((await call("read_file", { path: "a", offset: 1.5 })).status).toBe("error");
    expect((await call("get_task", { task_id: "../local-config/auth" })).status).toBe("error");
  }));
  it("normalizes optional nulls from strict tools without weakening required fields", () => runWithWorkdir(ws, async () => {
    const result = await call("write_file", { path: "new", content: "x", expected_hash: null });
    expect(result.status).toBe("success"); expect((await call("write_file", { path: null, content: "x" })).status).toBe("error");
  }));
  it("restricted verifier cannot write source even when OS isolation is unavailable", () => runWithWorkdir(ws, () => runWithAgentContext(createAgentContext({role: "verifier",agentName: "verify"}), async () => {
    const result = await call("run_bash", {command: "printf marker > source-marker", run_in_background: false, timeout_ms: 5000});
    expect(result.status).toBe("error"); expect(fs.existsSync(path.join(ws,"source-marker"))).toBe(false);
  })));
  it("all specialist allowlists refer to registered tools and contain glob", () => {
    for (const allow of Object.values(ROLE_TOOL_ALLOWLIST)) { expect(allow.has("glob")).toBe(true); for (const name of allow) expect(TOOL_MAP.has(name)).toBe(true); }
  });
});

describe("verification contract", () => {
  it("rejects command compositions that would hide the test exit code", () => runWithWorkdir(ws, async () => {
    const result = await call("run_verification", { command: "node --test; echo EXIT_CODE", requirement: "tests must pass" });
    expect(result.status).toBe("error"); expect(result.output).toContain("exit-code masking");
  }));
  it("reports failed and passing unchanged test programs with their real exit codes", () => runWithWorkdir(ws, async () => {
    fs.writeFileSync(path.join(ws, "contract.test.cjs"), "require('node:test').test('contract',()=>{throw Error('behavior differs')})");
    const result = await call("run_verification", { command: "node --test", requirement: "existing external contract" });
    expect(result.status).toBe("error"); expect(result.exitCode).toBe(1); expect(result.output).toContain("behavior differs");
  }));
});

describe("edits and recoverable artifacts", () => {
  it("rejects ambiguous edits and stale versions without changing content", () => runWithWorkdir(ws, async () => {
    const p = path.join(ws, "code.txt"); fs.writeFileSync(p, "enabled enabled");
    expect((await call("edit_file", { path: "code.txt", old_text: "enabled", new_text: "disabled" })).status).toBe("error"); expect(fs.readFileSync(p, "utf8")).toBe("enabled enabled");
    const hash = fileHash(fs.readFileSync(p)); fs.writeFileSync(p, "user change");
    expect((await call("write_file", { path: "code.txt", content: "replacement", expected_hash: hash })).status).toBe("error"); expect(fs.readFileSync(p, "utf8")).toBe("user change");
  }));
  it("validates all files before a multi-file patch and preserves user conflicts", () => runWithWorkdir(ws, async () => {
    fs.writeFileSync(path.join(ws, "a"), "one\r\n"); fs.writeFileSync(path.join(ws, "b"), "two\n");
    const fail = await call("apply_patch", { edits: [{ path: "a", old_text: "one", new_text: "ONE" }, { path: "b", old_text: "missing", new_text: "TWO" }] });
    expect(fail.status).toBe("error"); expect(fs.readFileSync(path.join(ws, "a"), "utf8")).toBe("one\r\n");
    const good = await call("apply_patch", { edits: [{ path: "a", old_text: "one", new_text: "ONE" }, { path: "b", old_text: "two", new_text: "TWO" }] });
    expect(good.status).toBe("success"); expect(fs.readFileSync(path.join(ws, "a"), "utf8")).toBe("ONE\r\n");
  }));
  it("restores a checkpoint but refuses to overwrite a later user edit", () => runWithWorkdir(ws, async () => {
    fs.writeFileSync(path.join(ws, "a"), "before");
    const result = await call("write_file", { path: "a", content: "after" }); const id = result.output.match(/Checkpoint: ([\da-f-]+)/)![1];
    expect(restoreFileCheckpoint(id)).toContain("Restored"); expect(fs.readFileSync(path.join(ws, "a"), "utf8")).toBe("before");
    const next = await call("write_file", { path: "a", content: "agent" }); fs.writeFileSync(path.join(ws, "a"), "user");
    expect(() => restoreFileCheckpoint(next.output.match(/Checkpoint: ([\da-f-]+)/)![1])).toThrow("conflict");
  }));
  it("retains dirty work and new files, exports artifacts, integrates and unblocks", () => runWithWorkdir(ws, async () => {
    initRepo(); const task = createTask("implementation"); const downstream = createTask("verification", "", [task.id]); await claimTask(task.id);
    const wt = taskWorktreePath(task.id); fs.writeFileSync(path.join(wt, "code.txt"), "implementation\n"); fs.writeFileSync(path.join(wt, "new.bin"), Buffer.from([0, 255, 1]));
    expect(removeTaskWorktree(task.id)).toBe(false); await completeTask(task.id);
    const stored = JSON.parse(getTask(task.id)); expect(stored.status).toBe("ready_for_review"); expect(canStart(downstream.id)).toBe(false); expect(fs.existsSync(wt)).toBe(true);
    expect(fs.existsSync(path.join(stored.artifact.directory, "manifest.json"))).toBe(true);
    await integrateTask(task.id); expect(JSON.parse(getTask(task.id)).status).toBe("completed"); expect(canStart(downstream.id)).toBe(true);
    expect(fs.readFileSync(path.join(ws, "new.bin"))).toEqual(Buffer.from([0, 255, 1])); expect(fs.existsSync(wt)).toBe(true);
  }));
  it("preserves committed unmerged branches and rejects integration conflicts", () => runWithWorkdir(ws, async () => {
    const git = initRepo(); const task = createTask("commit"); await claimTask(task.id); const wt = taskWorktreePath(task.id);
    fs.writeFileSync(path.join(wt, "code.txt"), "task\n"); execFileSync("git", ["add", "code.txt"], { cwd: wt }); execFileSync("git", ["commit", "-qm", "task"], { cwd: wt });
    expect(removeTaskWorktree(task.id)).toBe(false); expect(git("branch", "--list", "agent/task-task_1")).toContain("agent/task-task_1");
    expect(preserveTaskArtifact(task.id)?.files).toHaveLength(1); await completeTask(task.id); fs.writeFileSync(path.join(ws, "code.txt"), "user\n");
    await expect(integrateTask(task.id)).rejects.toThrow("conflict"); expect(fs.readFileSync(path.join(ws, "code.txt"), "utf8")).toBe("user\n");
  }));
});

describe("model failures, audit history and shared budgets", () => {
  it("keeps a completed file write when cancelling the next tool, including after reopen", async () => {
    const mock = await MockOpenAI.create(); installMockModels(mock.baseUrl); const controller = new AbortController();
    const session = SessionManager.create(ws, path.join(ws, "sessions")); session.appendMessage({ role: "user", content: "go" });
    const dispose = registerHook("PostToolUse", block => { if (block.name === "write_file") controller.abort(); });
    try {
      mock.push(() => ({ kind: "sse", chunks: [{ toolCalls: [{ index: 0, id: "write", name: "write_file", arguments: '{"path":"side-effect","content":"done"}' }, { index: 1, id: "read", name: "read_file", arguments: '{"path":"side-effect"}' }], finishReason: "tool_calls" }] }));
      const result = await runWithWorkdir(ws, () => agentLoopDetailed(session.buildSessionContext().messages, { session, loopOptions: new LoopOptions({ ...quiet, signal: controller.signal }) }));
      expect(result.status).toBe("cancelled"); expect(fs.readFileSync(path.join(ws, "side-effect"), "utf8")).toBe("done");
      const reopened = SessionManager.open(session.getSessionFile()!); expect(reopened.buildSessionContext().messages.filter(m => m.role === "tool").map(m => m.toolStatus)).toEqual(["success", "cancelled"]);
      expect(reopened.getEntries().some(e => e.type === "custom" && e.customType === "tool_completed")).toBe(true);
    } finally { dispose(); await mock.close(); }
  });
  it("counts retry and summary requests against the same budget", async () => {
    const mock = await MockOpenAI.create(); installMockModels(mock.baseUrl);
    try {
      const budget = new TaskBudget({ requests: 1 });
      mock.push(() => ({ kind: "sse", chunks: [{ content: "summary", finishReason: "stop" }] }));
      await runWithBudget(budget, () => completeText("summarize"));
      await expect(runWithBudget(budget, () => completeText("second"))).rejects.toBeInstanceOf(BudgetExceeded);
      expect(mock.requests).toHaveLength(1); expect(budget.usage.requests).toBe(1); budget.dispose();
    } finally { await mock.close(); }
  });
  it("inherited child scopes cannot obtain a fresh budget", async () => {
    const budget = new TaskBudget({ tools: 1 });
    await runWithBudget(budget, async () => { await Promise.resolve(); expect(currentBudget()).toBe(budget); currentBudget()!.useTool(); expect(() => currentBudget()!.useTool()).toThrow(BudgetExceeded); }); budget.dispose();
  });
  it("rejects cost limits when model pricing is unknown", () => {
    const budget = new TaskBudget({ cost: 1 }); expect(() => budget.reserveRequest(100, null)).toThrow("price is unknown"); expect(budget.usage.requests).toBe(0); budget.dispose();
  });
  it("rejects model calls before a token reservation exceeds budget", async () => {
    const mock = await MockOpenAI.create(); installMockModels(mock.baseUrl);
    try { const result = await runWithWorkdir(ws, () => agentLoopDetailed([{ role: "user", content: "go" }], { loopOptions: quiet, budget: { tokens: 10 } })); expect(result.status).toBe("budget_exceeded"); expect(mock.requests).toHaveLength(0); }
    finally { await mock.close(); }
  });
  it("stops after exhausting the shared request budget during retry", async () => {
    const mock = await MockOpenAI.create(); installMockModels(mock.baseUrl);
    const {setRetryPolicyForTest} = await import("../src/error-recovery.ts"); setRetryPolicyForTest({ enabled: true, maxRetries: 1, baseDelayMs: 1 });
    mock.push(() => ({ kind: "error", status: 429, body: "rate limit" }));
    try { const result = await runWithWorkdir(ws, () => agentLoopDetailed([{ role: "user", content: "go" }], { loopOptions: quiet, budget: { requests: 1 } })); expect(result.status).toBe("budget_exceeded"); expect(mock.requests).toHaveLength(1); }
    finally { await mock.close(); }
  });
  it("classifies budget exhaustion during a multi-tool batch and preserves the first write", async () => {
    const mock = await MockOpenAI.create(); installMockModels(mock.baseUrl);
    mock.push(() => ({ kind: "sse", chunks: [{ toolCalls: [{index: 0,id: "first",name: "write_file",arguments:'{"path":"first","content":"done"}'},{index: 1,id: "second",name: "write_file",arguments:'{"path":"second","content":"blocked"}'}], finishReason: "tool_calls" }] }));
    try { const result = await runWithWorkdir(ws, () => agentLoopDetailed([{ role: "user", content: "go" }], { loopOptions: quiet, budget: { tools: 1 } })); expect(result.status).toBe("budget_exceeded"); expect(fs.existsSync(path.join(ws,"first"))).toBe(true); expect(fs.existsSync(path.join(ws,"second"))).toBe(false); }
    finally { await mock.close(); }
  });
  it("terminates a real SSE connection that never produces a token", async () => {
    vi.stubEnv("CLAUDE_PI_FIRST_TOKEN_TIMEOUT_MS", "150");
    const server = http.createServer((req, res) => { req.resume(); req.on("end", () => { res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders(); }); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = server.address() as { port: number }; installMockModels(`http://127.0.0.1:${address.port}/v1`);
    try { const result = await runWithWorkdir(ws, () => agentLoopDetailed([{ role: "user", content: "go" }], { loopOptions: quiet })); expect(result.status).toBe("timeout"); expect(result.reason).toContain("first token"); }
    finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it("preserves partial output when a stream stalls after producing text", async () => {
    vi.stubEnv("CLAUDE_PI_STREAM_IDLE_TIMEOUT_MS", "150");
    const server = http.createServer((req,res)=>{ req.resume(); req.on("end",()=>{res.writeHead(200,{"content-type":"text/event-stream"}); res.write('data: {"choices":[{"index":0,"delta":{"content":"partial evidence"},"finish_reason":null}]}\n\n');}); });
    await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve)); installMockModels(`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`);
    const messages: import("../src/client.ts").ChatMessage[] = [{role:"user",content:"go"}];
    try { const result = await runWithWorkdir(ws,()=>agentLoopDetailed(messages,{loopOptions:quiet})); expect(result.status).toBe("timeout"); expect(messages.at(-1)?.partial).toBe(true); expect(messages.at(-1)?.content).toContain("partial evidence"); }
    finally {server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve()));}
  });
  it("CLI SIGINT cancels a hung request, emits valid JSON and exits 130", async () => {
    let child: ReturnType<typeof execFile>;
    const server = http.createServer((req,res)=>{req.resume(); req.on("end",()=>{res.writeHead(200,{"content-type":"text/event-stream"}); res.flushHeaders(); setTimeout(()=>child.kill("SIGINT"),30);});});
    await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
    const config = createTestAgentDir(`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`);
    try {
      const output = await new Promise<{code:number;stdout:string}>(resolve=>{
        child=execFile(process.execPath,[path.resolve("bin/cpi.js"),"--mode","json","--no-session","go"],{cwd:ws,timeout:15000,env:{...process.env,PI_CODING_AGENT_DIR:config,PI_OFFLINE:"1"}},(error,stdout)=>resolve({code:error?Number((error as {code?:number}).code):0,stdout})); child.stdin?.end();
      });
      expect(output.code).toBe(130); expect(JSON.parse(output.stdout).status).toBe("cancelled");
    } finally {server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve())); fs.rmSync(config,{recursive:true,force:true});}
  },20000);
  it("CLI JSON reports a real HTTP 401 as error and exits nonzero", async () => {
    const mock = await MockOpenAI.create(); mock.push(() => ({ kind: "error", status: 401, body: '{"error":{"message":"invalid test credential"}}' })); const config = createTestAgentDir(mock.baseUrl);
    try {
      const output = await new Promise<{ code: number; stdout: string }>(resolve => {
        const child = execFile(process.execPath, [path.resolve("bin/cpi.js"), "--mode", "json", "--no-session", "go"], { cwd: ws, timeout: 20000, env: { ...process.env, PI_CODING_AGENT_DIR: config, PI_OFFLINE: "1" } }, (error, stdout) => resolve({ code: error ? Number((error as { code?: number }).code) : 0, stdout })); child.stdin?.end();
      });
      expect(output.code).toBe(1); expect(JSON.parse(output.stdout).status).toBe("error"); expect(JSON.parse(output.stdout).error).toContain("401");
    } finally { fs.rmSync(config, { recursive: true, force: true }); await mock.close(); }
  }, 25000);
});

describe("repository instructions and trusted extension lifecycle", () => {
  it("loads root-to-leaf instructions and discovers multiple package test commands", () => runWithWorkdir(ws, () => {
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "root instructions"); fs.mkdirSync(path.join(ws, "packages", "a"), { recursive: true });
    fs.writeFileSync(path.join(ws, "packages", "a", "CLAUDE.md"), "child instructions"); fs.writeFileSync(path.join(ws, "packages", "a", "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
    expect(instructionText("packages/a/file.ts")).toContain("child instructions"); expect(inspectRepository().packages[0]).toMatchObject({ directory: "packages/a", commands: { test: "npm run test" } });
    expect(instructionText("elsewhere/file.ts")).not.toContain("child instructions");
  }));
  it("stops an edit to deliver unseen child instructions before modifying a file", () => runWithWorkdir(ws, async () => {
    fs.mkdirSync(path.join(ws,"child")); fs.writeFileSync(path.join(ws,"child","AGENTS.md"),"Preserve the external contract");
    const budget = new TaskBudget();
    try {
      const first = await runWithBudget(budget, () => call("write_file",{path:"child/a",content:"implementation"}));
      expect(first.status).toBe("error"); expect(first.output).toContain("Preserve the external contract"); expect(fs.existsSync(path.join(ws,"child","a"))).toBe(false);
      expect((await runWithBudget(budget, () => call("write_file",{path:"child/a",content:"implementation"}))).status).toBe("success");
    } finally { budget.dispose(); }
  }));
  it("requires a new trust decision after project executable code changes", () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", path.join(ws, "config")); fs.mkdirSync(path.join(ws, ".agent", "extensions"), { recursive: true }); const file = path.join(ws, ".agent", "extensions", "a.ts");
    fs.writeFileSync(file, "export default () => {}"); expect(isProjectCodeTrusted(ws)).toBe(false); trustProjectCode(ws); expect(isProjectCodeTrusted(ws)).toBe(true); fs.writeFileSync(file, "export default () => console.log('changed')"); expect(isProjectCodeTrusted(ws)).toBe(false);
  });
  it("reload does not accumulate hooks or leave tools behind on unload", async () => {
    const file = path.join(ws, "extension.mjs"); fs.writeFileSync(file, `export default api => { api.on('reload_probe', () => { globalThis.__reloadProbe = (globalThis.__reloadProbe || 0) + 1; }); api.registerTool({name:'reload_probe_tool',description:'probe',parameters:{type:'object',properties:{}},execute:()=> 'probe'}); }`);
    const manager = new ExtensionManager({ registerTool: tool => registerExtensionTool(buildTool(tool)), registerCommand: () => {}, appendEntry: () => "" });
    const global = globalThis as typeof globalThis & { __reloadProbe?: number }; global.__reloadProbe = 0;
    try { await manager.load([file]); await manager.reload([file]); await triggerHooks("reload_probe"); expect(global.__reloadProbe).toBe(1); manager.unload(); expect(TOOL_MAP.has("reload_probe_tool")).toBe(false); await triggerHooks("reload_probe"); expect(global.__reloadProbe).toBe(1); }
    finally { manager.unload(); delete global.__reloadProbe; }
  });
});
