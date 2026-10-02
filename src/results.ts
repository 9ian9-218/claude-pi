/** Machine-readable results; the text adapter preserves the existing tool API. */
export type ExecutionStatus = "success" | "error" | "cancelled" | "timeout" | "budget_exceeded";

export interface ToolResult {
  status: ExecutionStatus;
  output: string;
  exitCode?: number | null;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
  durationMs?: number;
  truncated?: boolean;
  artifactRefs?: string[];
}

export interface RunResult {
  status: ExecutionStatus;
  final: string | null;
  reason?: string;
  budget?: { usage: import("./task-budget.ts").BudgetUsage; limits: import("./task-budget.ts").BudgetLimits };
}

export function toolResult(value: unknown): ToolResult {
  if (value && typeof value === "object" && "status" in value && "output" in value && typeof value.output === "string" && ["success", "error", "cancelled", "timeout", "budget_exceeded"].includes(String(value.status))) {
    return value as ToolResult;
  }
  const output = typeof value === "string" ? value : JSON.stringify(value) ?? "(no output)";
  let failed = /^Error\b|^Permission denied\b|^Blocked\b/.test(output);
  try {
    const parsed = JSON.parse(output);
    failed ||= parsed?.status === "error" || parsed?.isError === true;
  } catch { /* Legacy plain text tool. */ }
  return { status: failed ? "error" : "success", output };
}

export function errorResult(message: string): ToolResult {
  return { status: "error", output: JSON.stringify({ status: "error", message }) };
}
