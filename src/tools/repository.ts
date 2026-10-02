import { buildTool } from "./core.ts";
import { inspectRepository } from "../repository-context.ts";
import { runProcess } from "../process-runner.ts";
import { getWorkdir } from "../workdir.ts";
import { childEnvironment } from "../sandbox.ts";

export const REPOSITORY_INFO_TOOL = buildTool({ name: "repository_info", description: "Discover package roots, test/check/build commands and repository instructions. Commands are suggestions, not proof of passing tests.", parameters: { type: "object", properties: {}, additionalProperties: false }, execute: () => JSON.stringify(inspectRepository(), null, 2), isReadOnly: true });
export const SYMBOL_SEARCH_TOOL = buildTool({
  name: "symbol_search", description: "Find lexical definitions or references of an exact identifier using ripgrep. Results are candidates; confirm scope and call sites before editing. This is lexical search, not a language server.",
  parameters: { type: "object", properties: { symbol: { type: "string", pattern: "^[A-Za-z_$][A-Za-z0-9_$]*$" }, kind: { type: "string", enum: ["definition", "references"] } }, required: ["symbol", "kind"], additionalProperties: false },
  execute: async (args, ctx) => {
    const symbol = String(args.symbol);
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(symbol)) throw new Error("Invalid symbol identifier");
    const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = args.kind === "definition" ? `(?:function|class|interface|type|enum|def|fn|func|const|let|var)\\s+${escaped}([^A-Za-z0-9_$]|$)` : `(^|[^A-Za-z0-9_$])${escaped}([^A-Za-z0-9_$]|$)`;
    const result = await runProcess("rg", ["--line-number", "--no-heading", "--color", "never", "--glob", "!.agent/**", "--glob", "!*.lock", "--", pattern, "."], { cwd: getWorkdir(), env: childEnvironment(), signal: ctx?.signal, timeoutMs: 15_000 });
    return result.exitCode === 1 ? { ...result, status: "success", output: "No matching symbol candidates" } : result;
  }, isReadOnly: true,
});
