import fs from "node:fs";
import path from "node:path";
import { getWorkdir, runWithWorkdir } from "./workdir.ts";
import { createAgentContext, getAgentContext, runWithAgentContext } from "./teammates/context.ts";
import { integrateTaskArtifact, preserveWorkspaceArtifact, artifactIntegrated, type TaskArtifact } from "./worktree.ts";
import { withRepositoryLock } from "./repository-lock.ts";
import { recoverFileTransactions, rollbackFileTransaction } from "./file-transactions.ts";
import { finishWorkspace, readWorkspaceRecord, type WorkspaceBinding } from "./workspaces.ts";
import { currentBudget } from "./task-budget.ts";
import { newPipeline, savePipeline, loadPipeline, ownerAlive, ownerStart, workspaceDigest, artifactKey, assertOriginalAcceptance, parseReview, observedTests, type PipelineRecord } from "./pipeline-state.ts";
import type { SessionManager } from "./session-manager.ts";
import type { UiEventSink } from "./ui-events.ts";

interface PipelineOptions { session?: SessionManager | null; uiEvents?: UiEventSink; signal?: AbortSignal; pipelineId?: string }
const active = new Set<string>();
function cancelled(options: PipelineOptions): void {
  currentBudget()?.check();
  if (options.signal?.aborted) throw options.signal.reason ?? new DOMException("Cancelled", "AbortError");
}
function response(record: PipelineRecord): string {
  return JSON.stringify({ pipelineId: record.id, status: record.status, attempt: record.attempt, artifact: record.artifact, reviewer: record.reviewer, verification: record.verification, postIntegrationVerification: record.postIntegrationVerification, reason: record.reason });
}
function finish(record: PipelineRecord, status: PipelineRecord["status"], reason?: string): string {
  record.status = status; record.reason = reason; savePipeline(record); return response(record);
}
async function recoverWorker(record: PipelineRecord): Promise<void> {
  const binding = (record as PipelineRecord & { worker?: WorkspaceBinding }).worker;
  if (!binding) return;
  const lease = readWorkspaceRecord(binding.recordPath);
  if (!lease || lease.id !== binding.id) throw new Error("Worker workspace changed");
  if (lease.status !== "active") return;
  if (ownerAlive(lease)) throw new Error("Previous worker is still alive");
  await withRepositoryLock(record.targetRoot, () => {
    const dir = path.join(lease.worktreePath, ".agent", "processes");
    if (fs.existsSync(dir)) for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      const processRecord = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!["starting", "running"].includes(processRecord.status)) continue;
      if (!processRecord.childPid) throw new Error("Interrupted process start has no verifiable PID; delivery blocked");
      if (processRecord.childPid) {
        try { process.kill(processRecord.childPid, 0); throw new Error("Previous process still alive or PID unverifiable"); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; }
      }
      processRecord.status = "finished";
      fs.writeFileSync(file, JSON.stringify(processRecord));
    }
    recoverFileTransactions(lease.worktreePath);
    record.artifact = preserveWorkspaceArtifact(lease.worktreePath, lease.taskId, record.originalBaseSha ?? lease.baseSha, record.targetRoot);
    record.artifact.pipelineId = record.id;
    finishWorkspace(lease, "review");
    record.status = "checking"; savePipeline(record);
  });
}
async function verify(record: PipelineRecord, root: string, options: PipelineOptions): Promise<NonNullable<PipelineRecord["verification"]>> {
  const { executeToolCallResult } = await import("./tool.ts");
  const receipts: NonNullable<PipelineRecord["verification"]> = [];
  const parent = getAgentContext();
  for (const command of record.commands) {
    cancelled(options);
    const result = await runWithAgentContext(createAgentContext({ ...parent, role: "verifier", agentName: record.id + "-verifier", agentId: record.id + "-verifier" }), () => runWithWorkdir(root, () => executeToolCallResult({ id: record.id + "-verify-" + record.attempt + "-" + receipts.length, function: { name: "run_verification", arguments: JSON.stringify({ command: command.command, requirement: command.requirement }) } }, undefined, { session: options.session ?? undefined, signal: options.signal ?? currentBudget()?.controller.signal })));
    const logs = result.artifactRefs?.map(file => fs.readFileSync(file, "utf8")).join("\n") ?? result.output;
    receipts.push({ command: command.command, status: result.status, exitCode: result.exitCode, tests: observedTests(logs), artifactRefs: result.artifactRefs ?? [] });
    if (result.status === "cancelled" || result.status === "budget_exceeded") cancelled(options);
    if (/bubblewrap|bwrap|Restricted execution|Operation not permitted/i.test(result.output) && result.status !== "success") throw new Error("Verification environment unavailable: " + result.output);
  }
  return receipts;
}
function verificationPassed(record: PipelineRecord, receipts: NonNullable<PipelineRecord["verification"]>): boolean {
  return receipts.length === record.commands.length && receipts.every((v, i) => v.status === "success" && v.exitCode === 0 && (record.commands[i].kind !== "test" || v.tests >= (record.commands[i].minTests ?? 1)));
}

export async function runCodingPipeline(goal: string, options: PipelineOptions = {}): Promise<string> {
  const { spawnSubagent } = await import("./tool.ts");
  const root = getWorkdir();
  const record = options.pipelineId ? loadPipeline(root, options.pipelineId) : newPipeline(root, goal);
  if (record.status === "completed") return response(record);
  if (active.has(record.id) || (options.pipelineId && ownerAlive(record) && record.ownerPid !== process.pid)) throw new Error("Pipeline is owned by a live coordinator");
  active.add(record.id);
  try {
    cancelled(options);
    await withRepositoryLock(root, () => recoverFileTransactions(root));
    if (record.status === "integrating" && record.artifact) {
      await withRepositoryLock(root, async () => {
        if (artifactIntegrated(record.artifact!) && workspaceDigest(root) === record.candidateDigest) {
          const checks = await verify(record, root, options);
          if (verificationPassed(record, checks)) { record.postIntegrationVerification = checks; finish(record, "completed", "Recovered and revalidated integration"); return; }
        }
        if (record.integrationTransaction) rollbackFileTransaction(root, record.integrationTransaction);
        record.status = "checking"; savePipeline(record);
      });
      if (loadPipeline(root, record.id).status === "completed") return response(record);
    }
    await recoverWorker(record);
    record.ownerPid = process.pid; record.ownerStart = ownerStart(); savePipeline(record);
    let candidate: TaskArtifact | undefined = record.artifact;
    if (record.status === "approved") record.status = "checking";
    let originalBase = record.originalBaseSha ?? candidate?.baseSha;
    let feedback = record.reason ?? "";
    while (record.attempt <= record.maxRepairs) {
      cancelled(options);
      if (!candidate || record.status !== "checking") {
        record.status = "running"; record.reviewer = undefined; record.verification = undefined; savePipeline(record);
        let exported: TaskArtifact | undefined;
        const text = await spawnSubagent(record.goal + "\n" + (feedback ? "Repair these independent findings:\n" + feedback : "") + "\nOriginal tests and test entry points are independent acceptance; do not modify them.", {
          role: "worker", workspace: candidate?.worktree ?? root, runId: record.id + "-worker-" + record.attempt,
          parentSession: options.session, parentUiEvents: options.uiEvents, signal: options.signal, deferIntegration: true,
          onWorkspace: binding => { record.worker = binding; record.originalBaseSha ??= binding.baseSha; originalBase ??= binding.baseSha; savePipeline(record); },
          onArtifact: artifact => { exported = artifact; record.artifact = artifact; savePipeline(record); },
        });
        cancelled(options);
        if (!exported || text.startsWith("Error:")) return finish(record, "blocked", text || "Worker did not produce an artifact");
        candidate = exported;
        originalBase ??= candidate.baseSha;
        candidate = preserveWorkspaceArtifact(candidate.worktree, path.basename(candidate.directory), originalBase, root);
        candidate.targetRoot = record.targetRoot;
        candidate.pipelineId = record.id;
        record.artifact = candidate;
        record.status = "checking"; savePipeline(record);
      }
      assertOriginalAcceptance(record, candidate.worktree);
      record.artifactKey = artifactKey(candidate);
      record.candidateDigest = workspaceDigest(candidate.worktree);
      savePipeline(record);
      const review = await spawnSubagent("Independently review this frozen candidate for the user goal: " + record.goal + "\nReturn only JSON: {\"verdict\":\"pass\"|\"block\",\"findings\":[{\"severity\":\"critical\"|\"warning\"|\"suggestion\",\"message\":\"...\"}]}. Any critical finding requires block. Do not modify files. Original requirements outrank worker claims.", {
        role: "reviewer", workspace: candidate.worktree, parentSession: options.session, parentUiEvents: options.uiEvents, signal: options.signal,
      });
      cancelled(options);
      record.reviewer = parseReview(review);
      record.verification = await verify(record, candidate.worktree, options);
      savePipeline(record);
      assertOriginalAcceptance(record, candidate.worktree);
      if (workspaceDigest(candidate.worktree) !== record.candidateDigest) return finish(record, "blocked", "Candidate changed while checking");
      const passed = record.reviewer.verdict === "pass" && verificationPassed(record, record.verification);
      if (passed) {
        record.status = "approved"; savePipeline(record);
        cancelled(options);
        await withRepositoryLock(root, async () => {
          cancelled(options); record.status = "integrating"; savePipeline(record);
          await integrateTaskArtifact(candidate!, transactionId => { record.integrationTransaction = transactionId; savePipeline(record); });
          try {
            const integratedVerification = await verify(record, root, options);
            record.postIntegrationVerification = integratedVerification;
            savePipeline(record);
            if (!verificationPassed(record, integratedVerification) || workspaceDigest(root) !== record.candidateDigest) throw new Error("Integrated candidate failed revalidation");
          } catch (error) {
            if (record.integrationTransaction) rollbackFileTransaction(root, record.integrationTransaction);
            throw error;
          }
        });
        options.session?.appendCustom("pipeline_completed", { pipelineId: record.id, candidateDigest: record.candidateDigest, artifact: candidate });
        return finish(record, "completed");
      }
      feedback = JSON.stringify({ review: record.reviewer, verification: record.verification });
      record.reason = feedback; record.attempt++; record.status = "running"; savePipeline(record);
    }
    return finish(record, "blocked", "Repair limit reached: " + feedback);
  } catch (error) {
    const isCancelled = options.signal?.aborted || currentBudget()?.controller.signal.aborted || (error as Error).name === "AbortError";
    return finish(record, isCancelled ? "cancelled" : "blocked", String((error as Error).message ?? error));
  } finally { active.delete(record.id); }
}
