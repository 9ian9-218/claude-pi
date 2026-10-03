import fs from "node:fs";
import path from "node:path";
import { getAgentContext } from "./teammates/context.ts";
import { getWorkspaceBinding } from "./workdir.ts";
import { requireWritableWorkspace } from "./workspaces.ts";
import { repositoryInfo } from "./repository-lock.ts";

export interface Invocation { executable: string; args: string[]; env: NodeJS.ProcessEnv }

function systemExecutable(name: string): string {
  for (const dir of ["/usr/bin", "/bin", "/usr/local/bin"]) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Restricted execution requires a system-installed ${name}; project PATH executables are not trusted`);
}

export function childEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key)) delete env[key];
  }
  delete env.GIT_EXTERNAL_DIFF;
  for (const key of Object.keys(env)) if (/^(?:NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_.*|GIT_.*)$/.test(key)) delete env[key];
  delete env.GIT_CONFIG_COUNT;
  for (const key of Object.keys(env)) if (/^GIT_CONFIG_(?:KEY|VALUE)_/.test(key)) delete env[key];
  env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  env.GIT_CONFIG_SYSTEM = env.GIT_CONFIG_GLOBAL;
  env.GIT_PAGER = "cat";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_OPTIONAL_LOCKS = "0";
  return env;
}

/** Restricted roles use argv, never a shell. Arbitrary programs require an OS sandbox. */
export function readOnlyInvocation(command: string, cwd: string): Invocation {
  if (/[;&|><$`\\\n\r()]/.test(command)) throw new Error("Read-only role: shell operators and expansions are not allowed");
  const parts = command.match(/"[^"]*"|'[^']*'|[^\s'"]+/g) ?? [];
  if (parts.join(" ").replace(/\s/g, "") !== command.trim().replace(/\s/g, "")) throw new Error("Read-only role: malformed command");
  const words = parts.map(x => /^['"]/.test(x) ? x.slice(1, -1) : x);
  if (words[0] === "pwd" && words.length === 1) return { executable: systemExecutable("pwd"), args: [], env: childEnvironment() };
  const sub = words[1];
  if (words[0] !== "git" || !["diff", "status", "log", "show", "ls-files"].includes(sub)) {
    throw new Error("Read-only role: use file/search tools or git diff/status/log/show/ls-files");
  }
  const allowed = new Set(["--", "--stat", "--name-only", "--name-status", "--cached", "--staged", "--short", "--porcelain", "--branch", "--oneline", "--decorate", "--no-decorate", "--numstat", "--check", "-p", "-s", "--no-patch", "-n"]);
  for (let i = 2; i < words.length; i++) {
    const word = words[i];
    if (words[i - 1] === "-n" && /^\d{1,4}$/.test(word)) continue;
    if (word.startsWith("-") && !allowed.has(word) && !/^--max-count=\d{1,4}$/.test(word)) throw new Error(`Read-only role: option ${word} is not allowed`);
    if (path.isAbsolute(word) || word.split(/[\\/]/).includes("..")) throw new Error("Read-only role: path outside workspace");
  }
  // Disable helpers capable of launching commands from repository-local Git config.
  const args = ["--no-pager", "--literal-pathspecs", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", sub];
  if (sub === "diff" || sub === "show") args.push("--no-ext-diff", "--no-textconv");
  args.push(...words.slice(2));
  void cwd;
  return { executable: systemExecutable("git"), args, env: childEnvironment() };
}

export function shellInvocation(command: string, cwd: string): Invocation {
  const role = getAgentContext().role;
  if (role === "scout" || role === "reviewer" || role === "planner") return readOnlyInvocation(command, cwd);
  if (role !== "verifier") requireWritableWorkspace();
  const owned = Boolean(getWorkspaceBinding());
  const restricted = role === "verifier" || process.env.CLAUDE_PI_SANDBOX === "readonly";
  if (restricted || owned) {
    if (process.platform !== "linux") throw new Error("Restricted execution requires Linux bubblewrap; no unsafe fallback is enabled");
    const args = ["--die-with-parent", "--new-session", "--unshare-net", "--unshare-pid", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp"];
    // Start with an empty filesystem. Runtime files and the workspace are read-only;
    // home directories, other projects and credential stores are absent.
    for (const dir of ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"]) if (fs.existsSync(dir)) args.push("--ro-bind", dir, dir);
    args.push(restricted ? "--ro-bind" : "--bind", cwd, cwd);
    if (owned) {
      const info = repositoryInfo(cwd);
      if (!info.git) throw new Error("Isolated shell requires Git workspace metadata");
      args.push("--ro-bind", info.commonDir, info.commonDir);
      if (fs.existsSync(path.join(cwd, ".git"))) args.push("--ro-bind", path.join(cwd, ".git"), path.join(cwd, ".git"));
      // Reuse installed dependencies as read-only data; installation stays in the coordinator.
      const binding = getWorkspaceBinding()!;
      const dependencies = [binding.parentPath, binding.repositoryRoot].filter((p): p is string => Boolean(p)).map(p => path.join(p, "node_modules")).find(p => fs.existsSync(p));
      if (dependencies) args.push("--ro-bind", fs.realpathSync(dependencies), path.join(cwd, "node_modules"));
    }
    // Hide session credentials and extensions from test programs.
    const privateDir = path.join(cwd, ".agent");
    const outputDir = path.join(privateDir, "verifier-output");
    fs.mkdirSync(outputDir, { recursive: true });
    args.push("--tmpfs", privateDir, "--bind", outputDir, outputDir);
    args.push("--chdir", cwd, "--", "/bin/bash", "-c", command);
    return { executable: systemExecutable("bwrap"), args, env: { ...childEnvironment(), HOME: "/tmp", TMPDIR: "/tmp", CLAUDE_PI_TEST_OUTPUT_DIR: outputDir } };
  }
  return { executable: process.platform === "win32" ? "cmd.exe" : "/bin/bash", args: process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command], env: childEnvironment() };
}
