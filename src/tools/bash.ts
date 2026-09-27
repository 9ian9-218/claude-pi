/**
 * bash.ts — run_bash 工具（从 tool.ts 拆出）
 */
import { spawnSync } from "node:child_process";
import { getWorkdir } from "../workdir.ts";
import { buildTool } from "./core.ts";

// ── run_bash ──────────────────────────────────────────────────────────────

const BASH_TIMEOUT_MS = 120_000;

function execRunBash(args: Record<string, unknown>): string {
  const command = String(args["command"]);
  try {
    const r = spawnSync(command, {
      cwd: getWorkdir(),
      shell: true,
      encoding: "utf8",
      timeout: BASH_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (r.status === null) {
      return "Error: Timeout (120s)";
    }
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
    if (!out) return "(no output)";
    return out;
  } catch (e) {
    return `Error: ${String(e)}`;
  }
}

const BASH_SCHEMA = {
  type: "object",
  properties: {
    command: { type: "string", description: "The command to run" },
    run_in_background: {
      type: "boolean",
      description: "Whether to run the command in background",
    },
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
