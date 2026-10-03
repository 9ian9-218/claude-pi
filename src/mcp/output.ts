import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getWorkdir } from "../workdir.ts";
import { withFileLock } from "../file-lock.ts";
import { writeFileAtomic } from "../atomic-write.ts";
import { estimateTokens, truncateToTokens, PERSIST_THRESHOLD_TOKENS, PREVIEW_TOKENS } from "../compact.ts";

export const MCP_OUTPUT_QUOTA_BYTES = 8 * 1024 * 1024;
export const MCP_OUTPUT_QUOTA_FILES = 128;

/** MCP results have a separate rotating quota, so generic L3 cannot persist unbounded peer output. */
export async function finalizeMcpToolOutput(output: string, options: { root?: string; quotaBytes?: number; quotaFiles?: number } = {}): Promise<string> {
  if (estimateTokens(output) <= PERSIST_THRESHOLD_TOKENS) return output;
  const preview = truncateToTokens(output, PREVIEW_TOKENS);
  const root = fs.realpathSync(options.root ?? getWorkdir());
  let dir = root;
  for (const component of [".agent", "mcp", "results"]) {
    dir = path.join(dir, component);
    if (fs.existsSync(dir) && !fs.lstatSync(dir).isDirectory()) throw new Error("MCP output storage must use real directories");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return withFileLock(path.join(dir, "quota.lock"), () => {
    const quotaBytes = options.quotaBytes ?? MCP_OUTPUT_QUOTA_BYTES;
    const quotaFiles = options.quotaFiles ?? MCP_OUTPUT_QUOTA_FILES;
    const files = fs.readdirSync(dir).filter(name => /^[0-9a-f-]{36}\.txt$/.test(name)).map(name => ({ path: path.join(dir, name), stat: fs.lstatSync(path.join(dir, name)) }));
    if (files.some(f => !f.stat.isFile())) throw new Error("Invalid MCP result artifact");
    files.sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs || a.path.localeCompare(b.path));
    let size = files.reduce((sum, file) => sum + file.stat.size, 0);
    const incoming = Buffer.byteLength(output);
    if (incoming > quotaBytes) return `<persisted-output>\nFull output not saved: MCP storage quota exceeded.\nPreview:\n${preview}\n</persisted-output>`;
    while (files.length && (size + incoming > quotaBytes || files.length >= quotaFiles)) {
      const file = files.shift()!; fs.unlinkSync(file.path); size -= file.stat.size;
    }
    const target = path.join(dir, `${randomUUID()}.txt`);
    writeFileAtomic(target, output);
    return `<persisted-output>\nFull output: ${target}\nPreview:\n${preview}\n</persisted-output>`;
  });
}
