import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { getAgentDir } from "./settings.ts";
import { writeFileAtomic } from "./atomic-write.ts";

/** Trust authorizes executable project extensions and automatic stdio MCP launches. */
export function projectCodeFingerprint(root: string): string {
  const hash = createHash("sha256");
  const add = (file: string) => {
    if (!fs.existsSync(file)) return;
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error("Project code trust does not allow symbolic links");
    if (stat.isDirectory()) { for (const name of fs.readdirSync(file).sort()) add(path.join(file, name)); }
    else if (stat.isFile()) hash.update(path.relative(root, file)).update(fs.readFileSync(file));
  };
  add(path.join(root, ".agent", "extensions"));
  add(path.join(root, ".agent", "mcp.json"));
  return hash.digest("hex");
}
function trustPath(root: string): string {
  return path.join(getAgentDir(), "workspace-trust", createHash("sha256").update(fs.realpathSync(root)).digest("hex") + ".json");
}
export function isProjectCodeTrusted(root: string): boolean {
  try {
    const record = JSON.parse(fs.readFileSync(trustPath(root), "utf8"));
    return record.fingerprint === projectCodeFingerprint(root);
  } catch { return false; }
}
export function trustProjectCode(root: string): void {
  const target = trustPath(root);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  writeFileAtomic(target, JSON.stringify({ root: fs.realpathSync(root), fingerprint: projectCodeFingerprint(root), trustedAt: new Date().toISOString() }));
}
