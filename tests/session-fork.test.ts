import { beforeEach, afterEach, describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { SessionManager, setSessionRoot, closeOpenTurns } from "../src/session-manager.ts";
import { forkSession, runWithSessionWorkspace } from "../src/session-fork.ts";
import { getWorkdir, getWorkspaceBinding, runWithWorkdir } from "../src/workdir.ts";
import { createAgentContext, runWithAgentContext, resetAgentContext } from "../src/teammates/context.ts";
import { requireWritableWorkspace, finishWorkspace } from "../src/workspaces.ts";
import { applyFileTransaction } from "../src/file-transactions.ts";
import { runQueryDetailed } from "../src/query-pipeline.ts";
import { MockOpenAI } from "./helpers/mock-openai.ts";
import { installMockModels } from "./helpers/test-client.ts";
import { resetClient } from "../src/client.ts";

let root: string;
const project = path.resolve(import.meta.dirname, "..");
const tsxImport = createRequire(import.meta.url).resolve("tsx");
const moduleUrl = (name: string) => JSON.stringify(pathToFileURL(path.join(project, "src", name)).href);
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
function diskHeader(s: SessionManager) { return JSON.parse(fs.readFileSync(s.getSessionFile()!, "utf8").split("\n")[0]); }
function child(code: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { cwd: project });
    let output = "";
    proc.stdout.on("data", b => { output += b; }); proc.stderr.on("data", b => { output += b; });
    proc.on("error", reject); proc.on("close", code => resolve({ code, output }));
  });
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cpi-session-fork-"));
  setSessionRoot(path.join(root, ".agent", "sessions"));
  git("init", "-q", "-b", "main"); git("config", "user.name", "test"); git("config", "user.email", "test@example.invalid");
  fs.writeFileSync(path.join(root, ".gitignore"), ".agent/\n");
  fs.writeFileSync(path.join(root, "code.txt"), "base\n");
  git("add", "."); git("commit", "-qm", "base");
});
afterEach(() => { resetAgentContext(); resetClient(); fs.rmSync(root, { recursive: true, force: true }); });

describe("durable forks and navigation", () => {
  it("does not share mutable message objects with the source session", async () => {
    const source = SessionManager.create(root);
    const id = source.appendMessage({ role: "assistant", content: "parent value", tool_calls: [{ id: "tool", type: "function", function: { name: "read_file", arguments: '{"path":"parent"}' } }] });
    const fork = await forkSession(source);
    const copied = fork.getEntry(id)!;
    if (copied.type !== "message") throw new Error("Expected message");
    copied.message.content = "child projection";
    (copied.message.tool_calls![0] as { function: { arguments: string } }).function.arguments = '{"path":"child"}';
    const original = source.getEntry(id)!;
    expect(original.type === "message" && original.message.content).toBe("parent value");
    expect(original.type === "message" && (original.message.tool_calls![0] as { function: { arguments: string } }).function.arguments).toBe('{"path":"parent"}');
  });
  it("persists provenance, cross-cwd grouping and inactive historical branches", async () => {
    const source = SessionManager.create(root);
    const user = source.appendMessage({ role: "user", content: "question" });
    const old = source.appendMessage({ role: "assistant", content: "old" });
    source.branch(user); source.appendMessage({ role: "assistant", content: "new" });
    const other = path.join(root, "other"); fs.mkdirSync(other);
    const fork = await forkSession(source, { entryId: old, cwd: other });
    const reopened = SessionManager.open(fork.getSessionFile()!);
    expect(reopened.getHeader()).toMatchObject({ cwd: other, parentSession: source.getSessionFile(), fork: { sourceSessionId: source.sessionId, sourceEntryId: old, position: "after" } });
    expect(SessionManager.list(other).map(s => s.id)).toContain(fork.sessionId);
    expect(reopened.buildSessionContext().messages.map(m => m.content)).toEqual(["question", "old"]);
    expect(source.buildSessionContext().messages.map(m => m.content)).toEqual(["question", "new"]);
    expect(source.getTreeEntries().find(n => n.entry.id === old)?.active).toBe(false);
  });
  it("persists a root cursor, then advances it on a new branch", () => {
    const source = SessionManager.create(root);
    source.appendMessage({ role: "user", content: "old" }); source.resetLeaf();
    expect(SessionManager.open(source.getSessionFile()!).getLeafId()).toBeNull();
    const newId = source.appendMessage({ role: "user", content: "new" });
    expect(SessionManager.open(source.getSessionFile()!).getLeafId()).toBe(newId);
    expect(source.getTreeEntries().filter(e => e.depth === 0)).toHaveLength(2);
  });
  it("survives a crash after append but before cursor header cleanup", () => {
    const source = SessionManager.create(root);
    const first = source.appendMessage({ role: "user", content: "first" });
    source.appendMessage({ role: "assistant", content: "old" }); source.branch(first);
    fs.appendFileSync(source.getSessionFile()!, JSON.stringify({ type: "message", id: "crash-entry", parentId: first, timestamp: new Date().toISOString(), message: { role: "user", content: "new" } }) + "\n");
    expect(SessionManager.open(source.getSessionFile()!).getLeafId()).toBe("crash-entry");
  });
  it("supports before-root forks and rejects invalid nodes without creating files", async () => {
    const source = SessionManager.create(root);
    const user = source.appendMessage({ role: "user", content: "edit me" });
    const fork = await forkSession(source, { entryId: user, position: "before" });
    expect(fork.buildSessionContext().messages).toEqual([]);
    expect(diskHeader(fork).fork).toMatchObject({ sourceEntryId: user, position: "before" });
    const count = SessionManager.list(root).length;
    await expect(forkSession(source, { entryId: "invalid", workspace: "isolated" })).rejects.toThrow("Unknown entry");
    expect(SessionManager.list(root)).toHaveLength(count);
  });
  it("rolls partial parallel tool rounds back without dropping the next user query", async () => {
    const source = SessionManager.create(root);
    source.appendMessage({ role: "user", content: "read two" });
    source.appendMessage({ role: "assistant", content: "reading", tool_calls: ["a", "b"].map(id => ({ id, type: "function", function: { name: "read_file", arguments: "{}" } })) });
    const partial = source.appendMessage({ role: "tool", content: "a result", tool_call_id: "a" });
    const fork = await forkSession(source, { entryId: partial });
    fork.appendMessage({ role: "user", content: "try another approach" });
    const messages = fork.buildSessionContext().messages;
    expect(messages.some(m => m.role === "tool" || m.tool_calls?.length)).toBe(false);
    expect(messages.at(-1)?.content).toBe("try another approach");
    expect(source.getLeafId()).toBe(partial);
  });
  it("rejects unmatched tool IDs and overlapping assistant calls in recovery", () => {
    const call = { role: "assistant" as const, content: null, tool_calls: [{ id: "a", type: "function" as const, function: { name: "read_file", arguments: "{}" } }] };
    for (const tail of [{ role: "tool" as const, content: "wrong", tool_call_id: "wrong" }, call]) {
      const messages = closeOpenTurns([{ role: "user", content: "go" }, call, tail]);
      expect(messages.some(m => m.role === "tool" || m.tool_calls?.length)).toBe(false);
    }
  });
});

describe("session worktree isolation", () => {
  it("runs the complete model/tool loop against the fork's files", async () => {
    const fork = await forkSession(SessionManager.create(root), { workspace: "isolated" });
    await runWithSessionWorkspace(fork, () => applyFileTransaction([{ path: "code.txt", data: "isolated bytes\n" }]));
    const mock = await MockOpenAI.create();
    try {
      installMockModels(mock.baseUrl);
      mock.push(() => ({ kind: "sse", chunks: [{ toolCalls: [{ index: 0, id: "read-fork", name: "read_file", arguments: '{"path":"code.txt"}' }], finishReason: "tool_calls" }] }));
      mock.push(() => ({ kind: "sse", chunks: [{ content: "read isolated", finishReason: "stop" }] }));
      const result = await runQueryDetailed("read code.txt", { session: fork, runHooks: false, quietOutput: true });
      expect(result.status).toBe("success"); expect(result.final).toBe("read isolated");
      expect(mock.requests[1].messages.find(m => m.role === "tool")?.content).toContain("isolated bytes");
      expect(fs.readFileSync(path.join(root, "code.txt"), "utf8")).toBe("base\n");
      expect(SessionManager.open(fork.getSessionFile()!).buildSessionContext().messages.at(-1)?.content).toBe("read isolated");
    } finally { resetClient(); await mock.close(); }
  });
  it("forks concurrently from current dirty bytes, preserves index and separates writes", async () => {
    const source = SessionManager.create(root);
    source.appendMessage({ role: "user", content: "go" });
    fs.writeFileSync(path.join(root, "code.txt"), "staged\n"); git("add", "code.txt");
    fs.writeFileSync(path.join(root, "code.txt"), "dirty\n");
    fs.writeFileSync(path.join(root, ".env"), "PRIVATE_TEST_DATA");
    const head = git("rev-parse", "HEAD"), index = git("write-tree");
    const forks = await Promise.all([0, 1].map(() => forkSession(source, { workspace: "isolated" })));
    expect(new Set(forks.map(s => s.getHeader().cwd)).size).toBe(2);
    let entered = 0;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    await Promise.all(forks.map((fork, i) => runWithSessionWorkspace(fork, async () => {
      expect(requireWritableWorkspace()?.agentId).toBe(`session:${fork.sessionId}`);
      expect(fs.readFileSync(path.join(getWorkdir(), "code.txt"), "utf8")).toBe("dirty\n");
      expect(fs.existsSync(path.join(getWorkdir(), ".env"))).toBe(false);
      if (++entered === 2) release();
      await barrier;
      await applyFileTransaction([{ path: "code.txt", data: `fork ${i}\n` }]);
      expect(getWorkdir()).toBe(fork.getHeader().cwd);
    })));
    expect(fs.readFileSync(path.join(root, "code.txt"), "utf8")).toBe("dirty\n");
    expect(git("rev-parse", "HEAD")).toBe(head); expect(git("write-tree")).toBe(index);
    expect(SessionManager.list(root).map(s => s.id)).toEqual(expect.arrayContaining(forks.map(s => s.sessionId)));
    expect(diskHeader(forks[0]).workspace.baseSha).toMatch(/^[a-f0-9]{40}$/);
  }, 20000);
  it("forks an isolated session into another worktree and refuses sharing its lease", async () => {
    const source = await forkSession(SessionManager.create(root), { workspace: "isolated" });
    await expect(forkSession(source, { workspace: "shared" })).rejects.toThrow("exclusive workspace");
    const fork = await forkSession(source);
    expect(fork.getHeader().cwd).not.toBe(source.getHeader().cwd);
    expect(fork.getHeader().projectCwd).toBe(root);
  }, 20000);
  it("releases file ownership on switching and resumes a worktree in the same process", async () => {
    const source = await forkSession(SessionManager.create(root), { workspace: "isolated" });
    const file = source.getSessionFile()!;
    source.close(); source.close();
    expect(() => source.appendMessage({ role: "user", content: "closed" })).toThrow("closed");
    const restored = SessionManager.open(file);
    expect(restored.isConcurrent()).toBe(false);
    await runWithSessionWorkspace(restored, async () => {
      expect(requireWritableWorkspace()?.agentId).toBe(`session:${restored.sessionId}`);
    });
  });
  it("fails closed before appending a prompt when a workspace is closed", async () => {
    const fork = await forkSession(SessionManager.create(root), { workspace: "isolated" });
    await runWithSessionWorkspace(fork, async () => finishWorkspace(getWorkspaceBinding()!, "closed"));
    const before = fs.readFileSync(fork.getSessionFile()!, "utf8");
    await expect(runQueryDetailed("must not run", { session: fork, runHooks: false })).rejects.toThrow("workspace is missing");
    expect(fs.readFileSync(fork.getSessionFile()!, "utf8")).toBe(before);
  });
  it("does not override a delegated agent's workdir with parent session metadata", async () => {
    const source = SessionManager.create(root);
    const worker = path.join(root, "delegated"); fs.mkdirSync(worker);
    await runWithAgentContext(createAgentContext({ role: "subagent", agentId: "child" }), () => runWithWorkdir(worker, () => runWithSessionWorkspace(source, async () => {
      expect(getWorkdir()).toBe(worker);
    })));
  });
  it("recovers session metadata and a dead process's lease after restart", async () => {
    const result = await child(`import {SessionManager,setSessionRoot} from ${moduleUrl("session-manager.ts")}; import {forkSession} from ${moduleUrl("session-fork.ts")};setSessionRoot(${JSON.stringify(path.join(root, ".agent", "sessions"))});const source=SessionManager.create(${JSON.stringify(root)});source.appendMessage({role:'user',content:'parent'});console.log((await forkSession(source,{workspace:'isolated'})).getSessionFile());`);
    expect(result.code, result.output).toBe(0);
    const restored = SessionManager.open(result.output.trim());
    await runWithSessionWorkspace(restored, async () => {
      expect(requireWritableWorkspace()?.ownerPid).toBe(process.pid);
      expect(getWorkdir()).toBe(restored.getHeader().cwd);
      expect(restored.buildSessionContext().messages[0].content).toBe("parent");
      await applyFileTransaction([{ path: "code.txt", data: "resumed\n" }]);
    });
    expect(fs.readFileSync(path.join(root, "code.txt"), "utf8")).toBe("base\n");
  }, 20000);
  it("refuses another live process's isolated session", async () => {
    const fork = await forkSession(SessionManager.create(root), { workspace: "isolated" });
    const result = await child(`import {SessionManager} from ${moduleUrl("session-manager.ts")};import {runWithSessionWorkspace} from ${moduleUrl("session-fork.ts")};try {await runWithSessionWorkspace(SessionManager.open(${JSON.stringify(fork.getSessionFile())}),async()=>{throw new Error('UNSAFE');});process.exitCode=2;}catch(e){console.log(e.message);process.exitCode=3;}`);
    expect(result.code).toBe(3); expect(result.output).toMatch(/another instance|another live/); expect(result.output).not.toContain("UNSAFE");
  }, 20000);
  it("CLI forks a historical node with before semantics and an isolated worktree", () => {
    const source = SessionManager.create(root);
    const user = source.appendMessage({ role: "user", content: "historical query" });
    source.appendMessage({ role: "assistant", content: "old answer" });
    const config = path.join(root, ".agent", "test-config"); fs.mkdirSync(config, { recursive: true });
    fs.writeFileSync(path.join(config, "models.json"), '{"providers":{}}');
    fs.writeFileSync(path.join(config, "settings.json"), "{}");
    execFileSync(process.execPath, ["--import", tsxImport, path.join(project, "src", "cli.ts"), "--fork", source.getSessionFile()!, "--fork-entry", user, "--fork-position", "before", "--fork-workspace", "isolated"], {
      cwd: root, input: "q\n", encoding: "utf8", timeout: 15000,
      env: { ...process.env, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: config, CLAUDE_PI_AGENT_ROOT: root, CLAUDE_PI_SESSION_ROOT: path.join(root, ".agent", "sessions") },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const created = SessionManager.list(root).find(s => s.id !== source.sessionId)!;
    expect(created).toBeDefined();
    const restored = SessionManager.open(created.path);
    expect(restored.getHeader().fork).toMatchObject({ sourceEntryId: user, position: "before" });
    expect(restored.buildSessionContext().messages).toEqual([]);
    expect(restored.getHeader().workspace).toBeDefined();
  }, 20000);
});
