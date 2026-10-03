/**
 * spawn.ts — Teammate 孵化与运行（对齐 teammates/spawn.py）
 *
 * WORK → IDLE → SHUTDOWN 循环（async 协程替代线程）；
 * idle 阶段归 11（autonomous），10 中空闲等待 + shutdown 检查。
 */
import {
  MAX_ACTIVE_TEAMMATES,
  TEAM_LEAD_NAME,
  TEAMMATE_IDLE_TIMEOUT,
  TEAMMATE_WORK_MAX_TURNS,
} from "./constants.ts";
import { runWithAgentContext } from "./context.ts";
import { dispatchInboxBatch, maybeReinjectIdentity } from "./inbox-dispatch.ts";
import { idlePoll } from "./autonomous.ts";
import { sendIdleNotification, notifyTeammateTerminated, sendShutdownRequest } from "./lifecycle.ts";
import { sendPlainMessage } from "./mailbox.ts";
import {
  deactivateTeammate,
  ensureTeammateForSpawn,
  readTeamConfig,
  getLeaderName,
} from "./team-helpers.ts";
import { getSkillCatalog } from "../skill-load.ts";
import { SUBAGENT_IDENTITY } from "../prompt.ts";
import { LoopOptions } from "../loop-options.ts";
import { AgentProfile, profileToContext } from "../agent-profile.ts";
import { lockedPrint } from "../output-queue.ts";
import { UiEventSink } from "../ui-events.ts";
import { getWorkdir, runWithWorkdir } from "../workdir.ts";
import {
  appendAgentText,
  emptyAgentUsage,
  finishAgentRun,
  getAgentRun,
  startAgentRun,
  updateAgentRun,
} from "../agent-registry.ts";

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

async function runTeammateLoop(options: {
  name: string;
  role: string;
  teamName: string;
  color: string;
  initialPrompt: string;
  runId: number;
  /** 注册表运行 id：面板与用量聚合的键（teammate 是持久 agent，非一次性 subagent） */
  runKey: string;
  /** 测试注入：空闲上限与轮询间隔；缺省取常量（30 分钟 / 5 秒） */
  idleTimeoutMs?: number;
  idlePollIntervalMs?: number;
}): Promise<void> {
  const { name, role, teamName, color, initialPrompt, runId, runKey } = options;
  const profile = AgentProfile.teammate({
    teamName,
    agentName: name,
    agentId: `${name}@${teamName}`,
    color,
    agentType: role,
  });
  const ctx = profileToContext(profile);

  const { agentLoopDetailed } = await import("../agent-loop.ts");

  // 可观测性：teammate 的事件只喂注册表（TUI 折叠面板 / /agents），不占 lead 聊天区。
  // 它是持久 agent（WORK → IDLE → … 直到 shutdown / 空闲超时），故用量按回合累计。
  const agentSink = new UiEventSink();
  const usage = emptyAgentUsage();
  let turns = 0;
  let toolCalls = 0;
  agentSink.on("stream", (delta) => {
    if (delta.kind === "text") appendAgentText(runKey, delta.delta);
  });
  agentSink.on("tool", (event) => {
    if (event.phase === "start") {
      toolCalls += 1;
      updateAgentRun(runKey, { lastTool: event.name, toolCalls });
    }
  });
  agentSink.on("turnEnd", (event) => {
    turns += 1;
    if (event.usage) {
      usage.input += event.usage.input;
      usage.output += event.usage.output;
      usage.cacheRead += event.usage.cacheRead;
      usage.cacheWrite += event.usage.cacheWrite;
      usage.cost += event.usage.cost;
    }
    updateAgentRun(runKey, { turns, usage: { ...usage } });
  });

  const idleTimeoutMs = options.idleTimeoutMs ?? TEAMMATE_IDLE_TIMEOUT * 1000;
  const idleMinutes = Math.max(1, Math.round(idleTimeoutMs / 60000));

  try {
    const endReason = await runWithAgentContext(ctx, () => runWithWorkdir(getWorkdir(), async (): Promise<string> => {
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
        if (dispatch.shouldShutdown) return "收到 shutdown 请求，已结束";

        maybeReinjectIdentity(messages, { name, role, teamName });

        updateAgentRun(runKey, { phase: "working" });
        const result = await agentLoopDetailed(messages, {
          maxTurn: TEAMMATE_WORK_MAX_TURNS,
          maxTokens: 6000,
          loopOptions: LoopOptions.fromProfile(profile, { uiEvents: agentSink }),
        });
        if (result.status !== "success") throw new Error(`Teammate ${result.status}: ${result.reason ?? "no final result"}`);
        if (result.final) {
          await sendPlainMessage({
            fromAgent: name,
            toAgent: TEAM_LEAD_NAME,
            text: result.final,
            teamName,
            color,
          });
          updateAgentRun(runKey, { result: result.final });
          lockedPrint(`  \x1b[36m[${name}]\x1b[0m work round done — report sent to lead inbox`);
        }

        await sendIdleNotification({ agentName: name, teamName });

        // idle 阶段：收件箱 + 看板 auto-claim（autonomous）
        updateAgentRun(runKey, { phase: "idle" });
        const idleResult = await idlePoll({
          agentName: name,
          teamName,
          messages,
          isShutdownRequested: () => isShutdownRequested(teamName, name, runId),
          ...(options.idlePollIntervalMs !== undefined
            ? { pollIntervalMs: options.idlePollIntervalMs }
            : {}),
          idleTimeoutMs,
        });
        if (idleResult === "shutdown") return "收到 shutdown 请求，已结束";
        if (idleResult === "timeout") {
          // 空闲超限即视为该 teammate 结束：停止运行循环、从运行表移除
          const reason = `空闲超过 ${idleMinutes} 分钟，已结束`;
          lockedPrint(`  \x1b[33m[teammate] ${name} ${reason}\x1b[0m`);
          return reason;
        }
      }
      return "已结束";
    }));

    const run = getAgentRun(runKey);
    finishAgentRun(runKey, {
      status: "done",
      reason: endReason,
      // 已有交付物时保留交付物，否则用结束原因占位
      ...(run?.result === undefined ? { result: endReason } : {}),
    });
  } catch (err) {
    finishAgentRun(runKey, { status: "failed", error: String((err as Error)?.message ?? err) });
  } finally {
    // 同步翻转两张表：注册表状态（done/failed）、进程内 active 表、团队成员表。
    // 三者之间不能有 await —— 否则外部会看到「已结束」却又被判定为仍活跃/仍占位，
    // 重新 spawn 同名 teammate 会被团队成员表的 isActive 守卫误拒。
    activeTeammates.delete(teammateKey(teamName, name));
    deactivateTeammate(teamName, name);
    // 终止广播本身失败（例如团队目录已被移除）不得升级为未处理拒绝
    try {
      await notifyTeammateTerminated({ agentName: name, teamName });
    } catch (err) {
      lockedPrint(
        `  \x1b[33m[teammate] ${name} 终止广播失败：${String((err as Error)?.message ?? err)}\x1b[0m`,
      );
    }
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
  /** 测试注入：覆盖空闲上限与轮询间隔 */
  idleTimeoutMs?: number;
  idlePollIntervalMs?: number;
}): string {
  const { name, role, prompt, teamName, agentType = "general-purpose" } = options;
  if (readTeamConfig(teamName) === null) {
    return `Error: team '${teamName}' not found. Use create_team first.`;
  }
  const key = teammateKey(teamName, name);
  if (activeTeammates.has(key)) {
    return `Teammate '${name}' already active on team '${teamName}'`;
  }
  if (activeTeammates.size >= MAX_ACTIVE_TEAMMATES) {
    return (
      `Error: too many active teammates (${activeTeammates.size}/${MAX_ACTIVE_TEAMMATES}). ` +
      `Shut one down with shutdown_teammate before spawning another.`
    );
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

  // 可观测性：teammate 是持久 agent，登记进运行注册表（面板 / /agents / 用量聚合）。
  // 同团队同名重新 spawn 时加后缀，保留上一次运行的记录与用量，避免 totals 倒退。
  const baseRunKey = `${name}@${teamName}`;
  let runKey = baseRunKey;
  for (let n = 2; getAgentRun(runKey); n++) runKey = `${baseRunKey}·${n}`;
  startAgentRun({
    id: runKey,
    role: "teammate",
    label: `teammate · ${name} · ${prompt.slice(0, 40)}`,
  });

  void runTeammateLoop({
    name,
    role,
    teamName,
    color,
    initialPrompt: prompt,
    runId,
    runKey,
    ...(options.idleTimeoutMs !== undefined ? { idleTimeoutMs: options.idleTimeoutMs } : {}),
    ...(options.idlePollIntervalMs !== undefined
      ? { idlePollIntervalMs: options.idlePollIntervalMs }
      : {}),
  }).catch((err) => {
    lockedPrint(
      `  \x1b[31m[teammate] ${name} 运行异常：${String((err as Error)?.message ?? err)}\x1b[0m`,
    );
  });

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
