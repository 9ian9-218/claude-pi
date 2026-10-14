/** Session lineage and file isolation are independent; this service connects them explicitly. */
import fs from "node:fs";
import type { SessionManager } from "./session-manager.ts";
import { createWorkerWorkspace, restoreAgentWorkspace, validateWorkspace, finishWorkspace, type WorkspaceBinding } from "./workspaces.ts";
import { getWorkspaceBinding, runWithWorkdir } from "./workdir.ts";
import { getAgentContext, runWithAgentContext } from "./teammates/context.ts";

export interface ForkOptions {
  entryId?: string;
  position?: "before" | "after";
  workspace?: "shared" | "isolated";
  cwd?: string;
}

export async function forkSession(source: SessionManager, options: ForkOptions = {}): Promise<SessionManager> {
  const header = source.getHeader();
  const isolated = options.workspace === "isolated" || (options.workspace === undefined && !!header.workspace);
  if (header.workspace && !isolated) throw new Error("An isolated session cannot share its exclusive workspace. Use --isolated to fork a new workspace.");
  const projectCwd = options.cwd ?? header.projectCwd ?? header.cwd;
  // Validate the historical node before creating any session or worktree.
  if (options.entryId && !source.getEntry(options.entryId)) throw new Error(`Unknown entry: ${options.entryId}`);
  const target = source.createBranchedSession(options.entryId, { cwd: projectCwd, position: options.position });
  if (isolated) {
    let binding: WorkspaceBinding | undefined;
    try {
      // Snapshot current bytes, including uncommitted work; this is not a historical code rewind.
      binding = await createWorkerWorkspace(header.cwd, `session:${target.sessionId}`);
      target.bindWorkspace(binding, projectCwd);
    } catch (error) {
      if (binding) {
        try { finishWorkspace(binding, "review"); } catch { /* Retain the record and files for recovery. */ }
      }
      // Worktree creation has its own safe rollback. Never delete dirty worktrees here.
      target.close();
      fs.rmSync(target.getSessionFile()!, { force: true });
      throw error;
    }
  }
  return target;
}

/** Restore the session's lease before hooks, user append, model calls, or file writes. */
export async function runWithSessionWorkspace<T>(session: SessionManager | null | undefined, fn: () => Promise<T>): Promise<T> {
  const caller = getAgentContext();
  // Delegated agents already have their own workspace and actor identity.
  if (!session || caller.role !== "lead") return fn();
  if (!session.isPersisted() && !session.getHeader().workspace) return fn();
  const header = session.getHeader(), current = getWorkspaceBinding();
  if (header.workspace && session.isConcurrent()) throw new Error("Isolated session is already open in another instance; fork it before executing");
  if (current && !header.workspace) return fn();
  const actor = { ...caller, agentId: `session:${session.sessionId}` };
  const execute = async () => {
    await restoreAgentWorkspace();
    if (header.workspace) {
      const binding = getWorkspaceBinding();
      if (!binding || binding.id !== header.workspace.id || binding.recordPath !== header.workspace.recordPath || binding.worktreePath !== header.workspace.worktreePath || binding.agentId !== actor.agentId) {
        throw new Error("Session workspace is missing, closed, or belongs to another session");
      }
      validateWorkspace(binding);
    }
    return fn();
  };
  return runWithAgentContext(actor, () => current && current.id === header.workspace?.id
    ? execute()
    : runWithWorkdir(header.cwd, execute));
}
