import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { getWorkdir } from "./workdir.ts";

export interface RepositoryInstruction { path: string; scope: string; content: string }
/** Root-to-leaf instructions. Child directories override parent guidance. */
export function repositoryInstructions(target: string = getWorkdir()): RepositoryInstruction[] {
  const root = path.resolve(getWorkdir());
  const absolute = path.resolve(root, target);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) throw new Error("Instruction target outside workspace");
  let dir = fs.existsSync(absolute) && fs.statSync(absolute).isDirectory() ? absolute : path.dirname(absolute);
  const dirs: string[] = [];
  while (dir === root || dir.startsWith(root + path.sep)) { dirs.unshift(dir); if (dir === root) break; dir = path.dirname(dir); }
  const result: RepositoryInstruction[] = [];
  for (const scope of dirs) for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const file = path.join(scope, name);
    if (!fs.existsSync(file)) continue;
    const real = fs.realpathSync(file);
    if (real !== root && !real.startsWith(root + path.sep)) continue;
    if (!fs.statSync(real).isFile()) continue;
    if (fs.statSync(real).size > 64 * 1024) throw new Error(`Repository instructions exceed 64 KiB: ${file}`);
    result.push({ path: path.relative(root, file), scope: path.relative(root, scope) || ".", content: fs.readFileSync(real, "utf8") });
  }
  return result;
}
export function instructionText(target?: string): string {
  return repositoryInstructions(target).map(i => `\n\nRepository instructions (${i.path}; applies to ${i.scope}/):\n${i.content}`).join("");
}
export function instructionHash(text: string): string { return createHash("sha256").update(text).digest("hex"); }

export function inspectRepository(root = getWorkdir()) {
  const packages: Array<{ directory: string; language: string; commands: Record<string, string> }> = [];
  const queue: Array<[string, number]> = [[root, 0]];
  let visited = 0;
  while (queue.length && visited++ < 2000) {
    const [dir, depth] = queue.shift()!;
    const relative = path.relative(root, dir) || ".";
    const packagePath = path.join(dir, "package.json");
    if (fs.existsSync(packagePath)) {
      try {
        const data = JSON.parse(fs.readFileSync(packagePath, "utf8"));
        const manager = fs.existsSync(path.join(dir, "pnpm-lock.yaml")) ? "pnpm" : fs.existsSync(path.join(dir, "yarn.lock")) ? "yarn" : "npm";
        const commands: Record<string, string> = {};
        for (const name of Object.keys(data.scripts ?? {})) if (/test|check|lint|build/.test(name)) commands[name] = `${manager} run ${name}`;
        packages.push({ directory: relative, language: "JavaScript/TypeScript", commands });
      } catch { packages.push({ directory: relative, language: "JavaScript/TypeScript", commands: { error: "Invalid package.json" } }); }
    }
    for (const [marker, language, command] of [["pyproject.toml", "Python", "python -m pytest"], ["pytest.ini", "Python", "python -m pytest"], ["Cargo.toml", "Rust", "cargo test"], ["go.mod", "Go", "go test ./..."]]) {
      if (fs.existsSync(path.join(dir, marker)) && !packages.some(p => p.directory === relative && p.language === language)) packages.push({ directory: relative, language, commands: { test: command } });
    }
    if (depth >= 5) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !["node_modules", ".git", ".agent", ".task_outputs", ".venv", "target", "dist"].includes(entry.name)) queue.push([path.join(dir, entry.name), depth + 1]);
    }
  }
  return { root, packages, truncated: queue.length > 0, instructions: repositoryInstructions(root), note: "Commands are discovered suggestions. Confirm project documentation and collect real exit codes; never change expected behavior merely to match implementation." };
}
