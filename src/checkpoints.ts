import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { safePath } from "./tools/path.ts";
import { getWorkdir } from "./workdir.ts";
import { withRepositoryLock } from "./repository-lock.ts";
import { applyFileTransaction, recoverFileTransactions } from "./file-transactions.ts";

export function fileHash(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

interface FileCheckpoint { path: string; before: string | null; encoding?: "base64"; mode: number; afterHash: string }

export function saveFileCheckpoint(filePath: string, after: string | Buffer | null): string {
  const existed = fs.existsSync(filePath);
  const checkpoint: FileCheckpoint = {
    path: path.relative(getWorkdir(), filePath),
    before: existed ? fs.readFileSync(filePath).toString("base64") : null,
    encoding: "base64",
    mode: existed ? fs.statSync(filePath).mode & 0o777 : 0o600,
    afterHash: after === null ? "missing" : fileHash(after),
  };
  const dir = path.join(getWorkdir(), ".agent", "checkpoints");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(checkpoint), { mode: 0o600 });
  return id;
}

/** Refuse to overwrite a user's change made after the agent's edit. */
export async function restoreFileCheckpoint(id: string): Promise<string> {
  return withRepositoryLock(getWorkdir(), async () => {
  recoverFileTransactions();
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid checkpoint id");
  const p = path.join(getWorkdir(), ".agent", "checkpoints", `${id}.json`);
  const cp = JSON.parse(fs.readFileSync(p, "utf8")) as FileCheckpoint;
  const target = safePath(cp.path);
  if ((fs.existsSync(target) ? fileHash(fs.readFileSync(target)) : "missing") !== cp.afterHash) throw new Error("Checkpoint conflict: file changed after the agent edit");
  await applyFileTransaction([{ path: cp.path, data: cp.before === null ? null : cp.encoding === "base64" ? Buffer.from(cp.before, "base64") : cp.before, mode: cp.mode, expectedHash: cp.afterHash }]);
  return `Restored ${cp.path}`;
  });
}
