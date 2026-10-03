import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getWorkdir, runWithWorkdir } from "./workdir.ts";
import { withRepositoryLock } from "./repository-lock.ts";
import { safePath, realpathDeep } from "./tools/path.ts";
import { fileHash, saveFileCheckpoint } from "./checkpoints.ts";
import { writeFileAtomic } from "./atomic-write.ts";
import { requireWritableWorkspace, assertWorkspaceQuiescent } from "./workspaces.ts";

export interface FileChange { path: string; data: string | Buffer | null; mode?: number; expectedHash?: string | null; expectedExecutable?: boolean }
interface JournalFile { path: string; checkpointId: string; beforeHash: string; afterHash: string; beforeMode: number; afterMode: number }
interface Journal { version: 1; root: string; status: "prepared" | "committed" | "rolled_back" | "conflict"; files: JournalFile[] }

function changePath(root: string, relative: string): string {
  const lexical = safePath(relative);
  if (fs.existsSync(lexical) && fs.lstatSync(lexical).isSymbolicLink()) throw new Error("Editing symbolic links is not allowed");
  const target = realpathDeep(lexical);
  if (/^(?:\.git|\.agent)(?:[\\/]|$)/.test(path.relative(root, target))) throw new Error("Agent edits cannot modify Git or cpi control metadata");
  return target;
}
function syncDirectory(dir: string): void {
  if (process.platform === "win32") return;
  const fd = fs.openSync(dir, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function hashAt(p: string): string {
  if (!fs.existsSync(p)) return "missing";
  if (!fs.lstatSync(p).isFile()) throw new Error(`File transaction requires a regular file: ${p}`);
  return fileHash(fs.readFileSync(p));
}

/** Persist journal/checkpoint before exposing a changed file. */
function durableJson(p: string, value: unknown): void {
  writeFileAtomic(p, JSON.stringify(value, null, 2));
  const fd = fs.openSync(p, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (process.platform !== "win32") { const dir = fs.openSync(path.dirname(p), "r"); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); } }
}

function rollback(root: string, journal: Journal, journalPath: string): void {
  runWithWorkdir(root, () => {
    // Validate the whole recovery plan first. Never partially restore over user edits.
    for (const f of journal.files) {
      if (!/^[0-9a-f-]{36}$/.test(f.checkpointId)) throw new Error("Invalid checkpoint ID in journal");
      const p = changePath(root, f.path), current = hashAt(p);
      const mode = current === "missing" ? 0 : fs.statSync(p).mode & 0o777;
      if (![f.beforeHash, f.afterHash].includes(current) || (current !== "missing" && ![f.beforeMode, f.afterMode].includes(mode))) {
        journal.status = "conflict"; durableJson(journalPath, journal);
        throw new Error(`Recovery conflict: ${f.path} changed after the interrupted transaction`);
      }
      const cp = JSON.parse(fs.readFileSync(path.join(root, ".agent", "checkpoints", `${f.checkpointId}.json`), "utf8"));
      if (cp.path !== f.path || (cp.before === null ? "missing" : fileHash(Buffer.from(cp.before, cp.encoding === "base64" ? "base64" : "utf8"))) !== f.beforeHash) throw new Error("Checkpoint integrity check failed");
    }
    for (const f of [...journal.files].reverse()) {
      const p = changePath(root, f.path);
      const cp = JSON.parse(fs.readFileSync(path.join(root, ".agent", "checkpoints", `${f.checkpointId}.json`), "utf8"));
      if (cp.before === null) { if (fs.existsSync(p)) fs.unlinkSync(p); }
      else { fs.mkdirSync(path.dirname(p), { recursive: true }); writeFileAtomic(p, Buffer.from(cp.before, cp.encoding === "base64" ? "base64" : "utf8")); fs.chmodSync(p, cp.mode); const fd = fs.openSync(p, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
      syncDirectory(path.dirname(p));
    }
    journal.status = "rolled_back"; durableJson(journalPath, journal);
  });
}

/** Must be called under the repository writer lock. Pending journals block writes. */
export function recoverFileTransactions(root = getWorkdir()): void {
  const dir = path.join(root, ".agent", "transactions");
  if (!fs.existsSync(dir)) return;
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith(".json"))) {
    const p = path.join(dir, file), journal = JSON.parse(fs.readFileSync(p, "utf8")) as Journal;
    if (journal.version !== 1 || journal.root !== fs.realpathSync(root)) throw new Error("Invalid transaction journal");
    if (journal.status === "prepared" || journal.status === "conflict") rollback(root, journal, p);
  }
}

export async function applyFileTransaction(changes: FileChange[], options: { afterApply?: (index: number) => void; coordinator?: boolean } = {}): Promise<string[]> {
  const root = fs.realpathSync(getWorkdir());
  return withRepositoryLock(root, () => {
    if (!options.coordinator) requireWritableWorkspace();
    assertWorkspaceQuiescent(root);
    recoverFileTransactions(root);
    const seen = new Set<string>();
    const plan = changes.map(change => {
      const p = changePath(root, change.path), beforeHash = hashAt(p);
      if (seen.has(p)) throw new Error("Duplicate file in transaction"); seen.add(p);
      if (change.expectedHash !== undefined && beforeHash !== (change.expectedHash ?? "missing")) throw new Error(`Edit conflict: ${change.path} changed before integration`);
      const beforeMode = beforeHash === "missing" ? 0 : fs.statSync(p).mode & 0o777;
      if (change.expectedExecutable !== undefined && beforeHash !== "missing" && Boolean(beforeMode & 0o111) !== change.expectedExecutable) throw new Error(`Edit conflict: ${change.path} mode changed`);
      return { change, p, beforeHash, beforeMode };
    });
    const dir = path.join(root, ".agent", "transactions"); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const journalPath = path.join(dir, `${randomUUID()}.json`);
    const journal: Journal = { version: 1, root, status: "prepared", files: plan.map(({ change, p, beforeHash, beforeMode }) => {
      const checkpointId = saveFileCheckpoint(p, change.data);
      const fd = fs.openSync(path.join(root, ".agent", "checkpoints", `${checkpointId}.json`), "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      return { path: path.relative(root, p), checkpointId, beforeHash, afterHash: change.data === null ? "missing" : fileHash(change.data), beforeMode, afterMode: change.mode ?? (beforeMode || 0o600) };
    }) };
    if (journal.files.length) syncDirectory(path.join(root, ".agent", "checkpoints"));
    durableJson(journalPath, journal);
    try {
      plan.forEach(({ change, p, beforeHash }, i) => {
        if (hashAt(p) !== beforeHash) throw new Error(`Edit conflict: ${change.path} changed during integration`);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        if (change.data === null) { if (fs.existsSync(p)) fs.unlinkSync(p); }
        else { writeFileAtomic(p, change.data); fs.chmodSync(p, journal.files[i].afterMode); const fd = fs.openSync(p, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
        syncDirectory(path.dirname(p));
        options.afterApply?.(i);
      });
      journal.status = "committed"; durableJson(journalPath, journal);
      return journal.files.map(f => f.checkpointId);
    } catch (e) {
      try { rollback(root, journal, journalPath); } catch (recovery) { throw new Error(`${String(e)}; ${String(recovery)}`); }
      throw e;
    }
  });
}
