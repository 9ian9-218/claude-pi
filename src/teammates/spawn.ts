/**
 * spawn.ts — Teammate 孵化与运行（对齐 teammates/spawn.py）
 *
 * WORK → IDLE → SHUTDOWN 循环（async 协程替代线程）；
 * idle 阶段归 11（autonomous），10 中空闲等待 + shutdown 检查。
 */
import { TEAM_LEAD_NAME, TEAMMATE_WORK_MAX_TURNS, getTeamsDir } from "./constants.ts";
import { createAgentContext, runWithAgentContext } from "./context.ts";
import { dispatchInboxBatch, maybeReinjectIdentity } from "./inbox-dispatch.ts";
import { sendIdleNotification, notifyTeammateTerminated, sendShutdownRequest } from "./lifecycle.ts";
import { sendPlainMessage } from "./mailbox.ts";
import { ensureTeammateForSpawn, readTeamConfig, getLeaderName } from "./team-helpers.ts";
import { getSkillCatalog } from "../skill-load.ts";
import { SUBAGENT_IDENTITY } from "../prompt.ts";
import { LoopOptions } from "../loop-options.ts";
import { lockedPrint } from "../output-queue.ts";

interface ActiveTeammate {
  runId: number;
  shutdown: () => void;
}

const activeTeammates = new Map<string, ActiveTeammate>();
let spawnCounter = 0;

function teammateKey(teamName: string, name: string): string {
  return `${teamName}/${name}`;
}

export function isTeammateActive(teamName: string, name: string): boolean {
  return activeTeammates.has(teammateKey(teamName, name));
}

function teammateIdentity(name: string, role: string, teamName: string): string {
  return (
    `You are teammate '${name}' on team '${teamName}', role: ${role}. ` +
    `Complete assigned work; use list_tasks / claim_task / complete_task on the shared board. ` +
    `When idle, unclaimed tasks may be auto-assigned to you. ` +
    `Submit plans via send_message(message_type=plan_approval) before major changes. ` +
    `When done with a unit of work: send_message a concise summary to '${TEAM_LEAD_NAME}'. ` +
    `You cannot spawn other teammates.`
  );
}

let running = false;

async function runTeammateLoop(options: {
  name: string;
  role: string;
  teamName: string;
  color: string;
  initialPrompt: string;
  runId: number;
}): Promise<void> {
  const { name, role, teamName, color, initialPrompt, runId } = options;
  const ctx = createAgentContext({
    teamName,
    agentName: name,
    agentId: `${name}@${teamName}`,
    color,
    role: "teammate",
    agentType: role,
  });

  const { agentLoop } = await import("../agent-loop.ts");

  try {
    await runWithAgentContext(ctx, async () => {
      const system =
        teammateIdentity(name, role, teamName) +
        "\n\n" +
        SUBAGENT_IDENTITY.replace("{workspace}", process.cwd()) +
        "\n\n" +
        getSkillCatalog();
      const messages = [
        { role: "system" as const, content: system },
        { role: "user" as const, content: initialPrompt },
      ];

      while (!isShutdownRequested(teamName, name, runId)) {
        const dispatch = await dispatchInboxBatch({ agentName: name, teamName, messages });
        if (dispatch.shouldShutdown) break;

        maybeReinjectIdentity(messages, { name, role, teamName });

        const result = await agentLoop(messages, {
          maxTurn: TEAMMATE_WORK_MAX_TURNS,
          maxTokens: 6000,
          loopOptions: LoopOptions.teammate(),
        });
        if (result) {
          await sendPlainMessage({
            fromAgent: name,
            toAgent: TEAM_LEAD_NAME,
            text: result,
            teamName,
            color,
          });
          lockedPrint(`  \x1b[36m[${name}]\x1b[0m work round done — report sent to lead inbox`);
        }

        await sendIdleNotification({ agentName: name, teamName });

        // idle 阶段（10：等待 + shutdown 检查；11 接入 autonomous idle_poll）
        const idleWait = 200;
        for (let i = 0; i < 25; i++) {
          if (isShutdownRequested(teamName, name, runId)) break;
          await new Promise((r) => setTimeout(r, idleWait));
        }
      }
    });
  } finally {
    await notifyTeammateTerminated({ agentName: name, teamName });
    activeTeammates.delete(teammateKey(teamName, name));
    lockedPrint(`  \x1b[32m[teammate] ${name} stopped\x1b[0m`);
  }
}

function isShutdownRequested(teamName: string, name: string, runId: number): boolean {
  const entry = activeTeammates.get(teammateKey(teamName, name));
  return !entry || entry.runId !== runId;
}

export function spawnTeammate(options: {
  name: string;
  role: string;
  prompt: string;
  teamName: string;
  agentType?: string;
}): string {
  const { name, role, prompt, teamName, agentType = "general-purpose" } = options;
  if (readTeamConfig(teamName) === null) {
    return `Error: team '${teamName}' not found. Use create_team first.`;
  }
  const key = teammateKey(teamName, name);
  if (activeTeammates.has(key)) {
    return `Teammate '${name}' already active on team '${teamName}'`;
  }

  let color: string;
  try {
    const member = ensureTeammateForSpawn(teamName, name, agentType);
    color = member.color;
  } catch (e) {
    return `Error: ${String((e as Error).message)}`;
  }

  spawnCounter += 1;
  const runId = spawnCounter;
  const entry: ActiveTeammate = {
    runId,
    shutdown: () => activeTeammates.delete(key),
  };
  activeTeammates.set(key, entry);

  void runTeammateLoop({ name, role, teamName, color, initialPrompt: prompt, runId });

  lockedPrint(`  \x1b[36m[teammate] ${name} spawned (${color}) on team '${teamName}'\x1b[0m`);
  return (
    `Teammate '${name}' spawned as ${role} (color: ${color}). ` +
    `Autonomous idle polling enabled — results arrive via lead inbox.`
  );
}

export function requestTeammateShutdown(name: string, teamName: string): Promise<string> {
  const key = teammateKey(teamName, name);
  const entry = activeTeammates.get(key);
  if (!entry) {
    return Promise.resolve(`Teammate '${name}' is not active on team '${teamName}'`);
  }
  const leader = getLeaderName(teamName);
  return sendShutdownRequest({ targetName: name, teamName, fromAgent: leader }).then(
    (requestId) => `Shutdown request ${requestId} sent to '${name}'`,
  );
}

export function listActiveTeammateNames(teamName?: string): string[] {
  const names: string[] = [];
  for (const [key, entry] of activeTeammates) {
    void entry;
    const [t, name] = key.split("/");
    if (teamName === undefined || t === teamName) names.push(name);
  }
  return names;
}

/** 测试隔离 */
export function clearActiveTeammates(): void {
  activeTeammates.clear();
}
