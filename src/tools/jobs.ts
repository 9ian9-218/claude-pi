import { buildTool } from "./core.ts";
import { getBackgroundJobs, killBgTask } from "../background-task.ts";

export const BACKGROUND_JOB_TOOL = buildTool({
  name: "background_job", description: "List, inspect/wait for, or cancel a background job. A started job is not proof of success; inspect final status and exit code before reporting tests passed. wait_ms is capped at 30 seconds. Restarted jobs with unknown state must be checked manually.",
  parameters: { type: "object", properties: { action: { type: "string", enum: ["list", "status", "cancel"] }, job_id: { type: "string" }, wait_ms: { type: "integer", minimum: 0, maximum: 30000 } }, required: ["action"], additionalProperties: false },
  execute: async (args, ctx) => {
    if (args.action === "cancel") return killBgTask(String(args.job_id));
    const end = Date.now() + Number(args.wait_ms ?? 0);
    let jobs: unknown[];
    do {
      if (ctx?.signal?.aborted) return { status: "cancelled", output: "Error: job wait cancelled" };
      jobs = getBackgroundJobs().filter(job => !args.job_id || (job as { id: string }).id === args.job_id);
      if (args.action === "list" || Date.now() >= end || !jobs.some(job => (job as { status: string }).status === "running")) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (true);
    return JSON.stringify(jobs, null, 2);
  }, isReadOnly: false,
});
