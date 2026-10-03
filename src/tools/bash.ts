/**
 * bash.ts — run_bash 工具（从 tool.ts 拆出）
 */
import { getWorkdir } from "../workdir.ts";
import { buildTool, type ToolExecContext } from "./core.ts";
import { runProcess } from "../process-runner.ts";
import { shellInvocation } from "../sandbox.ts";
import { withRepositoryLock } from "../repository-lock.ts";
import { getWorkspaceBinding } from "../workdir.ts";
import { recoverFileTransactions } from "../file-transactions.ts";

// ── run_bash ──────────────────────────────────────────────────────────────

const BASH_TIMEOUT_MS = 120_000;

async function execRunBash(args: Record<string, unknown>, ctx?: ToolExecContext) {
  const command = String(args["command"]);
  const invocation = shellInvocation(command, getWorkdir());
  const run = () => runProcess(invocation.executable, invocation.args, {
    cwd: getWorkdir(), signal: ctx?.signal, env: invocation.env,
    timeoutMs: typeof args.timeout_ms === "number" ? args.timeout_ms : BASH_TIMEOUT_MS,
  });
  // A trusted lead's non-isolated shell is serialized with main-workspace edits.
  return getWorkspaceBinding() ? run() : withRepositoryLock(getWorkdir(), () => { recoverFileTransactions(); return run(); });
}

const BASH_SCHEMA = {
  type: "object",
  properties: {
    command: { type: "string", description: "The command to run" },
    run_in_background: {
      type: "boolean",
      description: "Whether to run the command in background",
    },
    timeout_ms: { type: "integer", minimum: 1, maximum: 3600000, description: "Command timeout in milliseconds (default 120000)." },
  },
  required: ["command", "run_in_background"],
  additionalProperties: false,
};

export const RUN_BASH_TOOL = buildTool({
  name: "run_bash",
  description: "Run a shell command. Use when the user asks to run a command.",
  parameters: BASH_SCHEMA,
  execute: execRunBash,
  isReadOnly: false,
});

// ── read_file ─────────────────────────────────────────────────────────────
