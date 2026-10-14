import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { repositoryGit, repositoryInfo, withRepositoryLock } from "./repository-lock.ts";
import { writeFileAtomic } from "./atomic-write.ts";
import type { TaskArtifact } from "./worktree.ts";

export interface AcceptanceCommand { command: string; requirement: string; kind: "test" | "check"; minTests?: number }
export interface PipelineRecord {
  schemaVersion: 1; id: string; goal: string; targetRoot: string; baseDigest: string;
  status: "running" | "checking" | "approved" | "integrating" | "completed" | "blocked" | "cancelled";
  integrationTransaction?: string;
  originalBaseSha?: string; worker?: import("./workspaces.ts").WorkspaceBinding;
  attempt: number; maxRepairs: number; ownerPid: number; ownerStart: string;
  commands: AcceptanceCommand[]; protectedFiles: Record<string, string>; artifact?: TaskArtifact;
  artifactKey?: string; candidateDigest?: string; reviewer?: { verdict: "pass" | "block"; findings: unknown[] };
  verification?: Array<{ command: string; status: string; exitCode?: number | null; tests: number; artifactRefs: string[] }>;
  postIntegrationVerification?: PipelineRecord["verification"];
  reason?: string; updatedAt: string;
}
export function ownerStart(pid = process.pid): string {
  try { return fs.readFileSync("/proc/" + pid + "/stat", "utf8").split(") ")[1].split(" ")[19]; } catch { return "unknown"; }
}
export function ownerAlive(record: Pick<PipelineRecord, "ownerPid" | "ownerStart">): boolean {
  try { process.kill(record.ownerPid, 0); return record.ownerStart === "unknown" || ownerStart(record.ownerPid) === record.ownerStart; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
export function sourceFiles(root: string): string[] {
  return [...new Set(repositoryGit(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0"))]
    .filter(p => p && !/^(?:\.agent|\.git|\.task_outputs|\.transcripts|node_modules)(?:\/|$)/.test(p) && !/(?:^|\/)(?:\.env(?:\..*)?|auth\.json|credentials)$/.test(p)).sort();
}
export function hashFile(file: string): string {
  if (!fs.existsSync(file)) return "missing";
  const stat = fs.lstatSync(file);
  if (!stat.isFile()) throw new Error("Candidate requires regular files: " + file);
  return createHash("sha256").update(fs.readFileSync(file)).update(String(stat.mode & 0o111)).digest("hex");
}
export function workspaceDigest(root: string): string {
  const hash = createHash("sha256");
  for (const file of sourceFiles(root)) hash.update(file).update("\0").update(hashFile(path.join(root, file))).update("\0");
  return hash.digest("hex");
}
export function artifactKey(artifact: TaskArtifact): string {
  return createHash("sha256").update(JSON.stringify({ directory: artifact.directory, worktree: artifact.worktree, baseSha: artifact.baseSha, headSha: artifact.headSha, targetRoot: artifact.targetRoot, files: artifact.files })).digest("hex");
}
function recordPath(root: string, id: string): string {
  if (!/^pipeline-[a-f0-9-]+$/.test(id)) throw new Error("Invalid pipeline ID");
  return path.join(repositoryInfo(root).root, ".agent", "pipelines", id + ".json");
}
export function savePipeline(record: PipelineRecord): void {
  record.updatedAt = new Date().toISOString();
  const file = recordPath(record.targetRoot, record.id);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileAtomic(file, JSON.stringify(record, null, 2));
  const fd = fs.openSync(file, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (process.platform !== "win32") { const dir = fs.openSync(path.dirname(file), "r"); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); } }
}
export function loadPipeline(root: string, id: string): PipelineRecord {
  const record = JSON.parse(fs.readFileSync(recordPath(root, id), "utf8")) as PipelineRecord;
  if (record.schemaVersion !== 1 || record.id !== id || fs.realpathSync(record.targetRoot) !== fs.realpathSync(root)) throw new Error("Pipeline identity or workspace mismatch");
  return record;
}
export function acceptancePlan(root: string): { commands: AcceptanceCommand[]; maxRepairs: number; protectedFiles: Record<string, string> } {
  const configPath = path.join(root, ".agent", "pipeline.json");
  let commands: AcceptanceCommand[];
  let maxRepairs = 2;
  if (fs.existsSync(configPath)) {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    commands = config.commands; maxRepairs = config.maxRepairs ?? 2;
  } else {
    const packageFile = path.join(root, "package.json");
    if (!fs.existsSync(packageFile)) throw new Error("Unattended pipeline requires .agent/pipeline.json with an independent test command");
    const scripts = JSON.parse(fs.readFileSync(packageFile, "utf8")).scripts ?? {};
    if (!scripts.test) throw new Error("No independent test entry point; configure .agent/pipeline.json");
    commands = [];
    if (scripts.typecheck) commands.push({ command: "npm run typecheck", requirement: "Original typecheck passes", kind: "check" });
    commands.push({ command: "npm test", requirement: "Original tests pass with nonzero test count", kind: "test", minTests: 1 });
  }
  if (!Number.isInteger(maxRepairs) || maxRepairs < 0 || maxRepairs > 5) throw new Error("maxRepairs must be 0..5");
  if (!Array.isArray(commands) || !commands.length || commands.length > 10 || !commands.some(c => c.kind === "test")) throw new Error("Acceptance plan requires 1..10 commands and at least one test");
  for (const c of commands) if (typeof c.command !== "string" || !c.command.trim() || typeof c.requirement !== "string" || !c.requirement.trim() || !["test", "check"].includes(c.kind) || (c.minTests !== undefined && (!Number.isInteger(c.minTests) || c.minTests < 1))) throw new Error("Invalid acceptance command");
  const protectedFiles: Record<string, string> = {};
  for (const p of sourceFiles(root)) if (/^(?:tests?|__tests__)\//.test(p) || /(?:^|\/)(?:[^/]*[._-](?:test|spec)\.[^/]+|package\.json|[^/]*lock[^/]*|pyproject\.toml|Cargo\.toml|go\.mod|[^/]*(?:vitest|jest|pytest|tsconfig)[^/]*)$/.test(p)) protectedFiles[p] = hashFile(path.join(root, p));
  if (!Object.keys(protectedFiles).length) throw new Error("No original acceptance files to protect");
  return { commands, maxRepairs, protectedFiles };
}
export function newPipeline(root: string, goal: string): PipelineRecord {
  if (!goal.trim()) throw new Error("Pipeline goal must not be empty");
  const plan = acceptancePlan(root);
  return { schemaVersion: 1, id: "pipeline-" + randomUUID(), goal, targetRoot: fs.realpathSync(root), baseDigest: workspaceDigest(root), status: "running", attempt: 0, ownerPid: process.pid, ownerStart: ownerStart(), ...plan, updatedAt: new Date().toISOString() };
}
export function assertOriginalAcceptance(record: PipelineRecord, root: string): void {
  for (const [file, hash] of Object.entries(record.protectedFiles)) if (hashFile(path.join(root, file)) !== hash) throw new Error("Independent acceptance file changed: " + file);
}
export function parseReview(text: string): { verdict: "pass" | "block"; findings: unknown[] } {
  const value = JSON.parse(text.trim());
  if (!["pass", "block"].includes(value.verdict) || !Array.isArray(value.findings)) throw new Error("Reviewer must return a structured verdict and findings");
  if (value.findings.some((f: unknown) => !f || typeof f !== "object" || typeof (f as { severity?: unknown }).severity !== "string" || !["critical", "warning", "suggestion"].includes((f as { severity: string }).severity))) throw new Error("Invalid review finding");
  if (value.findings.some((f: { severity: string }) => f.severity === "critical")) value.verdict = "block";
  return value;
}
export function observedTests(output: string): number {
  const plain = output.replace(/\x1b\[[0-9;]*m/g, "");
  const patterns = [/# tests\s+(\d+)/g, /\bTests\s*:?\s+(\d+)\s+passed/g, /\b(\d+)\s+passed\b/g, /\bRan\s+(\d+)\s+tests?\b/g];
  return Math.max(0, ...patterns.flatMap(pattern => [...plain.matchAll(pattern)].map(m => Number(m[1]))));
}
export function assertPipelineApproval(artifact: TaskArtifact): void {
  if (!artifact.pipelineId) throw new Error("Pipeline integration requires version-bound review and verification evidence");
  const record = loadPipeline(artifact.targetRoot!, artifact.pipelineId);
  if (!["approved", "integrating"].includes(record.status) || record.reviewer?.verdict !== "pass" || !record.verification?.length || record.artifactKey !== artifactKey(artifact)) throw new Error("Pipeline candidate has no valid approval");
  if (record.verification.length !== record.commands.length || record.verification.some((v, i) => v.command !== record.commands[i].command || v.status !== "success" || v.exitCode !== 0 || (record.commands[i].kind === "test" && v.tests < (record.commands[i].minTests ?? 1)))) throw new Error("Pipeline verification missing or failed");
  assertOriginalAcceptance(record, artifact.worktree);
  if (workspaceDigest(artifact.worktree) !== record.candidateDigest) throw new Error("Candidate changed after verification");
  if (workspaceDigest(record.targetRoot) !== record.baseDigest) throw new Error("Parent workspace changed; candidate must be revalidated");
}

/** Claim coordinator ownership under the same cross-process repository lock as integration. */
export async function claimPipeline(record: PipelineRecord, signal?: AbortSignal): Promise<PipelineRecord> {
  return withRepositoryLock(record.targetRoot, () => {
    signal?.throwIfAborted();
    let latest = record;
    try { latest = loadPipeline(record.targetRoot, record.id); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (["running", "checking", "approved", "integrating"].includes(latest.status) && latest.ownerPid !== process.pid && ownerAlive(latest)) throw new Error("Pipeline is owned by a live coordinator");
    if (latest.status !== "completed") { latest.ownerPid = process.pid; latest.ownerStart = ownerStart(); savePipeline(latest); }
    return latest;
  });
}
