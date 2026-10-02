import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { getAgentDir } from "./settings.ts";
import { getModelRuntime, resolveCurrentModel } from "./ai-runtime.ts";
import { isProjectCodeTrusted } from "./workspace-trust.ts";
import { inspectRepository } from "./repository-context.ts";
import { getBackgroundJobs } from "./background-task.ts";
import { budgetLimitsFromEnv, TaskBudget } from "./task-budget.ts";
import { shellInvocation } from "./sandbox.ts";
import { runWithAgentContext, createAgentContext } from "./teammates/context.ts";
import { runProcess } from "./process-runner.ts";

export async function runDoctor(options: { checkApi?: boolean } = {}) {
  const checks: Array<{ name: string; status: "ok" | "warning" | "error"; detail: unknown }> = [];
  const add = (name: string, status: "ok" | "warning" | "error", detail: unknown) => checks.push({ name, status, detail });
  add("environment", "ok", { node: process.version, platform: process.platform, cpus: os.availableParallelism(), memoryBytes: os.totalmem(), workspace: process.cwd(), configDirectory: getAgentDir() });
  for (const [name, args] of [["git", ["--version"]], ["rg", ["--version"]]]) {
    try { add(name as string, "ok", execFileSync(name as string, args as string[], { encoding: "utf8", timeout: 5000 }).split("\n")[0]); }
    catch { add(name as string, "error", "Not available on PATH"); }
  }
  add("proxy", process.env.HTTPS_PROXY && !process.env.NODE_USE_ENV_PROXY ? "warning" : "ok", { proxyConfigured: Boolean(process.env.HTTPS_PROXY || process.env.HTTP_PROXY), nodeUsesEnvProxy: process.env.NODE_USE_ENV_PROXY === "1", extraCaConfigured: Boolean(process.env.NODE_EXTRA_CA_CERTS) });
  const authPath = path.join(getAgentDir(), "auth.json");
  if (fs.existsSync(authPath)) add("credential_file_mode", process.platform === "win32" || !(fs.statSync(authPath).mode & 0o077) ? "ok" : "warning", "Credential values are never included in this report");
  const budget = new TaskBudget(budgetLimitsFromEnv());
  add("budgets", "ok", budget.limits); budget.dispose();
  add("project_code_trust", isProjectCodeTrusted(process.cwd()) ? "ok" : "warning", "Project extensions and automatic MCP launches require matching trust fingerprint");
  add("repository", "ok", inspectRepository());
  add("background_jobs", "ok", getBackgroundJobs().map(job => { const j = job as Record<string, unknown>; return { id: j.id, status: j.status, startedAt: j.startedAt }; }));
  try {
    const invocation = runWithAgentContext(createAgentContext({ role: "verifier", agentName: "doctor" }), () => shellInvocation("true", process.cwd()));
    const result = await runProcess(invocation.executable, invocation.args, { cwd: process.cwd(), env: invocation.env, timeoutMs: 5000 });
    add("readonly_sandbox", result.status === "success" ? "ok" : "warning", result.status === "success" ? "bubblewrap isolation available" : "bubblewrap unavailable or blocked; verifier commands fail closed. Trusted worker shells remain unrestricted.");
  } catch { add("readonly_sandbox", "warning", "No supported OS sandbox; restricted execution fails closed"); }
  try {
    const runtime = await getModelRuntime();
    const model = await resolveCurrentModel();
    add("model", runtime.getError() ? "error" : "ok", { provider: model.provider, id: model.id, baseUrl: model.baseUrl, contextWindow: model.contextWindow, maxTokens: model.maxTokens, price: model.cost.input || model.cost.output ? model.cost : "unknown", authConfigured: runtime.hasConfiguredAuth(model.provider) });
    if (options.checkApi) {
      const auth = await runtime.getAuth(model);
      const headers = Object.fromEntries(Object.entries({ ...model.headers, ...auth?.auth.headers }).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
      if (auth?.auth.apiKey) headers.Authorization = `Bearer ${auth.auth.apiKey}`;
      const response = await fetch(model.baseUrl.replace(/\/$/, "") + "/models", { headers, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) add("api_catalog", "error", { httpStatus: response.status });
      else {
        const body = await response.json() as { data?: Array<{ id: string }> };
        const ids = (body.data ?? []).map(m => m.id);
        add("api_catalog", ids.includes(model.id) ? "ok" : "warning", { httpStatus: response.status, modelAvailable: ids.includes(model.id), modelIds: ids });
      }
    }
  } catch { add("model_or_api", "error", "Configuration, authentication or connectivity failed. Check model IDs, proxy and CA settings."); }
  return { status: checks.some(c => c.status === "error") ? "error" : "ok", checks };
}
