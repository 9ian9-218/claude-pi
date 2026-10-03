import { buildTool } from "./core.ts";
import { runProcess } from "../process-runner.ts";
import { shellInvocation, childEnvironment } from "../sandbox.ts";
import { getWorkdir, getWorkspaceBinding } from "../workdir.ts";
import { withRepositoryLock } from "../repository-lock.ts";
import { recoverFileTransactions } from "../file-transactions.ts";
import { requireWritableWorkspace } from "../workspaces.ts";
import { getAgentContext } from "../teammates/context.ts";

export const RUN_VERIFICATION_TOOL = buildTool({
  name: "run_verification",
  description: "Run a test/build/typecheck command and preserve its actual exit code. Rejects pipelines, redirects, expansions and exit-code masking such as '; echo $?'. Supported: node --test, npm/pnpm/yarn test or run test/check/lint/build, python -m pytest/unittest, cargo test/check/build, go test/vet/build, npx --no-install vitest/tsc/jest/eslint. Verification evidence still needs to match the user's requirements; never rewrite tests merely to match the implementation.",
  parameters: { type: "object", properties: { command: { type: "string" }, requirement: { type: "string", description: "Observable acceptance criterion being checked" }, timeout_ms: { type: "integer", minimum: 1, maximum: 3600000 } }, required: ["command", "requirement"], additionalProperties: false },
  execute: async (args, ctx) => {
    const command = String(args.command);
    if (/[;&|><$`\\\n\r()%]/.test(command)) throw new Error("Verification must use a direct command without shell operators, expansions or exit-code masking");
    const parts = command.match(/"[^"]*"|'[^']*'|[^\s'"]+/g) ?? [];
    if (parts.join(" ").replace(/\s/g, "") !== command.trim().replace(/\s/g, "")) throw new Error("Malformed verification command");
    const words = parts.map(x => /^['"]/.test(x) ? x.slice(1, -1) : x);
    const [program, ...argv] = words;
    const allowed = program === "node" && argv[0] === "--test"
      || ["npm", "pnpm", "yarn"].includes(program) && (argv[0] === "test" || argv[0] === "run" && /^(?:test|check|typecheck|lint|build)(?:[:_-][\w-]+)?$/.test(argv[1] ?? ""))
      || ["python", "python3"].includes(program) && argv[0] === "-m" && ["pytest", "unittest"].includes(argv[1])
      || program === "cargo" && ["test", "check", "build"].includes(argv[0])
      || program === "go" && ["test", "vet", "build"].includes(argv[0])
      || program === "npx" && argv[0] === "--no-install" && ["vitest", "tsc", "jest", "eslint"].includes(argv[1]);
    if (!allowed) throw new Error("Unsupported verification command; inspect repository_info for supported test entry points");
    const quoted = words.map(word => `'${word.replace(/'/g, "'\\''")}'`).join(" ");
    if (getAgentContext().role !== "verifier") requireWritableWorkspace();
    const restricted = getAgentContext().role === "verifier" || process.env.CLAUDE_PI_SANDBOX === "readonly" || Boolean(getWorkspaceBinding());
    const invocation = restricted ? shellInvocation(quoted, getWorkdir()) : { executable: program, args: argv, env: childEnvironment() };
    const run = () => runProcess(invocation.executable, invocation.args, { cwd: getWorkdir(), env: invocation.env, signal: ctx?.signal, timeoutMs: Number(args.timeout_ms ?? 120000) });
    const result = await (getWorkspaceBinding() ? run() : withRepositoryLock(getWorkdir(), () => { recoverFileTransactions(); return run(); }));
    ctx?.session?.appendCustom("verification_completed", { command, requirement: args.requirement, status: result.status, exitCode: result.exitCode, artifactRefs: result.artifactRefs });
    return { ...result, output: `Verification ${result.status}; exit code ${result.exitCode ?? "none"}. Requirement: ${String(args.requirement)}\n${result.output}` };
  }, isReadOnly: false,
});
