/**
 * autonomous.ts — 自治队友（对齐 teammates/autonomous.py）
 *
 * idle 阶段：轮询收件箱 + 任务看板自动 claim；有工作则回到 WORK。
 */
import { TEAMMATE_IDLE_POLL_INTERVAL, TEAMMATE_IDLE_TIMEOUT } from "./constants.ts";
import { dispatchInboxBatch } from "./inbox-dispatch.ts";
import { tryClaimNextTask, loadTask } from "../tasks.ts";
import { lockedPrint } from "../output-queue.ts";
import type { ChatMessage } from "../client.ts";

export type IdleResult = "work" | "shutdown" | "timeout";

export function makeIdentityBlock(name: string, role: string, teamName: string): string {
  return (
    `<identity>You are teammate '${name}' on team '${teamName}', ` +
    `role: ${role}. Continue assigned work or claim tasks from the board.</identity>`
  );
}

export function maybeReinjectIdentity(
  messages: ChatMessage[],
  options: { name: string; role: string; teamName: string },
): void {
  const block = makeIdentityBlock(options.name, options.role, options.teamName);
  if (messages.length > 3) return;
  if (messages.length > 0 && messages[0].role === "system") {
    const next = messages[1]?.content ?? "";
    if (typeof next === "string" && next.includes(block)) return;
    messages.splice(1, 0, { role: "user", content: block });
  } else {
    messages.splice(0, 0, { role: "user", content: block });
  }
}

export interface IdlePollOptions {
  agentName: string;
  teamName: string;
  messages: ChatMessage[];
  isShutdownRequested: () => boolean;
  role?: string;
  pollIntervalMs?: number;
  idleTimeoutMs?: number;
}

/** 空闲轮询：收件箱 → 看板 auto-claim → 等待 */
export async function idlePoll(options: IdlePollOptions): Promise<IdleResult> {
  const { agentName, teamName, messages, isShutdownRequested, role = "" } = options;
  const pollIntervalMs = options.pollIntervalMs ?? TEAMMATE_IDLE_POLL_INTERVAL * 1000;
  const idleTimeoutMs = options.idleTimeoutMs ?? TEAMMATE_IDLE_TIMEOUT * 1000;
  const polls = Math.max(1, Math.trunc(idleTimeoutMs / pollIntervalMs));

  for (let i = 0; i < polls; i++) {
    if (isShutdownRequested()) return "shutdown";

    const dispatch = await dispatchInboxBatch({ agentName, teamName, messages });
    if (dispatch.shouldShutdown) {
      lockedPrint(`  \x1b[35m[idle] ${agentName} approved shutdown\x1b[0m`);
      return "shutdown";
    }
    if (dispatch.resumeWork) {
      lockedPrint(`  \x1b[36m[idle] ${agentName} inbox → resume work\x1b[0m`);
      return "work";
    }

    const result = await tryClaimNextTask(agentName);
    if (result.startsWith("Claimed")) {
      const taskId = result.split(" ")[1];
      const task = loadTask(taskId);
      messages.push({
        role: "user",
        content: `<auto-claimed>Task ${task.id}: ${task.subject}\n${task.description}</auto-claimed>`,
      });
      lockedPrint(`  \x1b[32m[idle] ${agentName} auto-claimed: ${task.subject}\x1b[0m`);
      return "work";
    }
    if (result !== "No unclaimed tasks available") {
      lockedPrint(`  \x1b[33m[idle] ${agentName} claim failed: ${result}\x1b[0m`);
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  lockedPrint(`  \x1b[31m[idle] ${agentName} timeout (${TEAMMATE_IDLE_TIMEOUT}s)\x1b[0m`);
  return "timeout";
}
