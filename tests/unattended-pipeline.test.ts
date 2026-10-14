import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockOpenAI } from "./helpers/mock-openai.ts";
import { installMockModels } from "./helpers/test-client.ts";
import { resetClient } from "../src/client.ts";
import { setSettingsOverrideForTest } from "../src/settings.ts";
import { runWithWorkdir, setWorkspaceBinding } from "../src/workdir.ts";
import { runWithAgentContext, createAgentContext } from "../src/teammates/context.ts";
import { createWorkerWorkspace, finishWorkspace } from "../src/workspaces.ts";
import { integrateTaskArtifact, preserveWorkspaceArtifact, setGitRoot } from "../src/worktree.ts";
import { newPipeline, savePipeline, artifactKey, workspaceDigest, assertPipelineApproval, parseReview, observedTests } from "../src/pipeline-state.ts";
import { runCodingPipeline } from "../src/pipeline.ts";
import { agentLoopDetailed } from "../src/agent-loop.ts";
import { SessionManager } from "../src/session-manager.ts";
import { spawnSubagent } from "../src/tool.ts";
import { listAgentRuns, clearAgentRuns } from "../src/agent-registry.ts";
import { applyFileTransaction, rollbackFileTransaction } from "../src/file-transactions.ts";
import { isToolBlockedByPreset } from "../src/tools/runtime.ts";
let root: string;
let mock: MockOpenAI;
function git(...args: string[]) { return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim(); }
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cpi-pipeline-"));
  git("init", "-q"); git("config", "user.name", "test"); git("config", "user.email", "test@example.com");
  fs.mkdirSync(path.join(root, "src")); fs.mkdirSync(path.join(root, "tests"));
  fs.writeFileSync(path.join(root, ".gitignore"), ".agent/\n.task_outputs/\nnode_modules/\n");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --test" } }));
  fs.writeFileSync(path.join(root, "src/value.js"), "export function value() { return 0; }\n");
  fs.writeFileSync(path.join(root, "tests/value.test.js"), "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {value} from '../src/value.js'; test('original contract',()=>assert.equal(value(),42));\n");
  git("add", "."); git("commit", "-qm", "baseline"); setGitRoot(root);
  mock = await MockOpenAI.create(); installMockModels(mock.baseUrl);
  setSettingsOverrideForTest({ retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 }, team: { mode: "pipeline" }, memory: { enabled: false } });
});
afterEach(async () => { resetClient(); setSettingsOverrideForTest(null); await mock.close(); fs.rmSync(root, { recursive: true, force: true }); });
function final(text: string) { mock.push(() => ({ kind: "sse", chunks: [{ content: text, finishReason: "stop" }] })); }
function worker(content = "export function value() { return 42; }\n") {
  mock.push(() => ({ kind: "sse", chunks: [{ toolCalls: [{ index: 0, id: "read", name: "read_file", arguments: JSON.stringify({ path: "src/value.js" }) }], finishReason: "tool_calls" }] }));
  mock.push(() => ({ kind: "sse", chunks: [{ toolCalls: [{ index: 0, id: "write", name: "write_file", arguments: JSON.stringify({ path: "src/value.js", content }) }], finishReason: "tool_calls" }] }));
  final("Implementation finished");
}
describe("unattended pipeline admission", () => {
  it("blocks alternate preset writes while preserving planning tools", () => {
    for (const tool of ["spawn_teammate", "create_team", "subagent_task", "mcp__remote__write", "extension_write"]) expect(isToolBlockedByPreset("lead", tool)).toBe(true);
    for (const tool of ["read_file", "todo_write", "delegate", "run_pipeline"]) expect(isToolBlockedByPreset("lead", tool)).toBe(false);
  });
  it("rejects malformed review and cannot pass a critical finding", () => {
    expect(() => parseReview("[PASS]")).toThrow();
    expect(parseReview('{"verdict":"pass","findings":[{"severity":"critical","message":"bug"}]}').verdict).toBe("block");
    expect(observedTests("# tests 1\n# pass 1")).toBe(1);
    expect(observedTests("Tests  12 passed (12)")).toBe(12);
    expect(observedTests("No tests found; success")).toBe(0);
  });
  it("does not accept empty or unbounded acceptance configuration", () => runWithWorkdir(root, () => {
    fs.mkdirSync(path.join(root, ".agent"));
    fs.writeFileSync(path.join(root, ".agent/pipeline.json"), JSON.stringify({ commands: [], maxRepairs: 200 }));
    expect(() => newPipeline(root, "fix")).toThrow();
  }));
  it("rejects direct integration without independent approval", async () => {
    const binding = await createWorkerWorkspace(root, "unapproved");
    fs.writeFileSync(path.join(binding.worktreePath, "src/value.js"), "changed");
    const artifact = preserveWorkspaceArtifact(binding.worktreePath, binding.taskId, binding.baseSha, root); finishWorkspace(binding, "review");
    await expect(runWithWorkdir(root, () => integrateTaskArtifact(artifact))).rejects.toThrow("requires version-bound");
    expect(fs.readFileSync(path.join(root, "src/value.js"), "utf8")).toContain("return 0");
  });
  it("invalidates approval after candidate edits or acceptance tampering", async () => {
    const binding = await createWorkerWorkspace(root, "versioned");
    const record = newPipeline(root, "fix");
    fs.writeFileSync(path.join(binding.worktreePath, "src/value.js"), "changed");
    const artifact = preserveWorkspaceArtifact(binding.worktreePath, binding.taskId, binding.baseSha, root); finishWorkspace(binding, "review"); artifact.pipelineId = record.id;
    record.artifact = artifact; record.artifactKey = artifactKey(artifact); record.candidateDigest = workspaceDigest(binding.worktreePath); record.status = "approved";
    record.reviewer = { verdict: "pass", findings: [] }; record.verification = [{ command: "npm test", status: "success", exitCode: 0, tests: 1, artifactRefs: [] }]; savePipeline(record);
    expect(() => assertPipelineApproval(artifact)).not.toThrow();
    fs.writeFileSync(path.join(binding.worktreePath, "src/value.js"), "later change");
    expect(() => assertPipelineApproval(artifact)).toThrow("Candidate changed");
    fs.writeFileSync(path.join(binding.worktreePath, "tests/value.test.js"), "no tests");
    expect(() => assertPipelineApproval(artifact)).toThrow("acceptance file changed");
  });
  it("restores an integration transaction and refuses later user edits", async () => {
    let id = "";
    await runWithWorkdir(root, () => applyFileTransaction([{ path: "src/value.js", data: "candidate" }], { onPrepared: value => { id = value; } }));
    rollbackFileTransaction(root, id); expect(fs.readFileSync(path.join(root, "src/value.js"), "utf8")).toContain("return 0");
    await runWithWorkdir(root, () => applyFileTransaction([{ path: "src/value.js", data: "candidate" }], { onPrepared: value => { id = value; } }));
    fs.writeFileSync(path.join(root, "src/value.js"), "user change");
    expect(() => rollbackFileTransaction(root, id)).toThrow("Recovery conflict"); expect(fs.readFileSync(path.join(root, "src/value.js"), "utf8")).toBe("user change");
  });
  it("reads child artifacts safely when integrating into a parent worktree", async () => {
    setSettingsOverrideForTest({ retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 }, team: { mode: "free" } });
    const parent = await createWorkerWorkspace(root, "parent"), child = await createWorkerWorkspace(parent.worktreePath, "child");
    fs.writeFileSync(path.join(child.worktreePath, "src/value.js"), "nested");
    const artifact = preserveWorkspaceArtifact(child.worktreePath, child.taskId, child.baseSha, parent.worktreePath); finishWorkspace(child, "review");
    await runWithAgentContext(createAgentContext({ role: "worker", agentId: "parent" }), () => runWithWorkdir(parent.worktreePath, async () => { setWorkspaceBinding(parent); await integrateTaskArtifact(artifact); }));
    expect(fs.readFileSync(path.join(parent.worktreePath, "src/value.js"), "utf8")).toBe("nested");
    expect(fs.readFileSync(path.join(root, "src/value.js"), "utf8")).toContain("return 0");
  });
  it("runs real readonly acceptance and integrates only the approved bytes", async () => {
    worker(); final('{"verdict":"pass","findings":[]}');
    const result = JSON.parse(await runWithWorkdir(root, () => runCodingPipeline("return 42")));
    expect(result.status, result.reason).toBe("completed");
    expect(fs.readFileSync(path.join(root, "src/value.js"), "utf8")).toContain("return 42");
    expect(result.verification[0]).toMatchObject({ exitCode: 0, tests: 1 });
  }, 30000);
  it("repairs a blocked candidate and preserves the original cumulative baseline", async () => {
    worker("export function value() { return 1; }\n"); final('{"verdict":"block","findings":[{"severity":"critical","message":"wrong result"}]}');
    worker(); final('{"verdict":"pass","findings":[]}');
    const result = JSON.parse(await runWithWorkdir(root, () => runCodingPipeline("return 42")));
    expect(result.status, result.reason).toBe("completed"); expect(result.attempt).toBe(1);
    expect(fs.readFileSync(path.join(root, "src/value.js"), "utf8")).toContain("return 42");
  }, 45000);
  it("keeps the parent untouched when the repair budget is zero", async () => {
    fs.mkdirSync(path.join(root, ".agent"));
    fs.writeFileSync(path.join(root, ".agent/pipeline.json"), JSON.stringify({ maxRepairs: 0, commands: [{ command: "npm test", requirement: "original contract", kind: "test", minTests: 1 }] }));
    worker("export function value() { return 1; }\n"); final('{"verdict":"block","findings":[]}');
    const result = JSON.parse(await runWithWorkdir(root, () => runCodingPipeline("return 42")));
    expect(result.status).toBe("blocked"); expect(fs.readFileSync(path.join(root, "src/value.js"), "utf8")).toContain("return 0");
    expect(fs.existsSync(result.artifact.worktree)).toBe(true);
  }, 30000);
});

it("does not charge inherited parent history or report its cache as child usage", async () => {
  clearAgentRuns();
  const parent = SessionManager.create(root);
  parent.appendMessage({ role: "user", content: "prior task" });
  parent.appendMessage({ role: "assistant", content: "prior answer", usage: { input: 100000, output: 100000, cacheRead: 100000, cacheWrite: 0, totalTokens: 300000, cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 0, total: 3 } } });
  final("scout result");
  await runWithWorkdir(root, () => spawnSubagent("inspect", { role: "scout", parentSession: parent }));
  const run = listAgentRuns().find(r => r.role === "scout")!;
  expect(run.usage!.input).toBeLessThan(100000); expect(run.firstTurnCache!.cacheRead).toBeLessThan(100000);
  const child = SessionManager.open(run.sessionFile!); child.close(); parent.close();
}, 15000);

it("resumes a committed integration by revalidating without repeating model work", async () => {
  const binding = await createWorkerWorkspace(root, "recovery");
  const record = newPipeline(root, "return 42");
  fs.writeFileSync(path.join(binding.worktreePath, "src/value.js"), "export function value() { return 42; }\n");
  const artifact = preserveWorkspaceArtifact(binding.worktreePath, binding.taskId, binding.baseSha, root); finishWorkspace(binding, "review"); artifact.pipelineId = record.id;
  record.artifact = artifact; record.artifactKey = artifactKey(artifact); record.candidateDigest = workspaceDigest(binding.worktreePath); record.status = "integrating";
  record.reviewer = { verdict: "pass", findings: [] }; record.verification = [{ command: "npm test", status: "success", exitCode: 0, tests: 1, artifactRefs: [] }];
  record.ownerPid = 2147483647; record.ownerStart = "dead"; savePipeline(record);
  await runWithWorkdir(root, () => integrateTaskArtifact(artifact, id => { record.integrationTransaction = id; savePipeline(record); }));
  const result = JSON.parse(await runWithWorkdir(root, () => runCodingPipeline("", { pipelineId: record.id })));
  expect(result.status, result.reason).toBe("completed"); expect(result.postIntegrationVerification[0].exitCode).toBe(0);
}, 20000);
it("rolls back when the integrated environment fails the unchanged acceptance", async () => {
  fs.appendFileSync(path.join(root, "tests/value.test.js"), "test('root condition',()=>{ if (!process.cwd().includes('/.agent/worktrees/')) assert.equal(value(),0); });\n");
  worker(); final('{"verdict":"pass","findings":[]}');
  const result = JSON.parse(await runWithWorkdir(root, () => runCodingPipeline("return 42")));
  expect(result.status, result.reason).toBe("blocked");
  expect(result.postIntegrationVerification[0].exitCode).not.toBe(0);
  expect(fs.readFileSync(path.join(root, "src/value.js"), "utf8")).toContain("return 0");
}, 20000);
it("cancels before starting model work and keeps the parent intact", async () => {
  const controller = new AbortController(); controller.abort(new DOMException("cancelled", "AbortError"));
  const result = JSON.parse(await runWithWorkdir(root, () => runCodingPipeline("return 42", { signal: controller.signal })));
  expect(result.status).toBe("cancelled"); expect(fs.readFileSync(path.join(root, "src/value.js"), "utf8")).toContain("return 0");
});

it("does not report successful delivery when the lead falsely declares completion", async () => {
  fs.mkdirSync(path.join(root, ".agent"));
  fs.writeFileSync(path.join(root, ".agent/pipeline.json"), JSON.stringify({ maxRepairs: 0, commands: [{ command: "npm test", requirement: "original contract", kind: "test", minTests: 1 }] }));
  mock.push(() => ({ kind: "sse", chunks: [{ toolCalls: [{ index: 0, id: "pipeline", name: "run_pipeline", arguments: '{"goal":"return 42"}' }], finishReason: "tool_calls" }] }));
  worker("export function value() { return 1; }\n"); final('{"verdict":"block","findings":[]}'); final("Everything is done");
  const result = await runWithWorkdir(root, () => agentLoopDetailed([{ role: "user", content: "return 42" }]));
  expect(result.status).toBe("error"); expect(result.reason).toContain("Pipeline delivery blocked");
  expect(fs.readFileSync(path.join(root, "src/value.js"), "utf8")).toContain("return 0");
}, 30000);
