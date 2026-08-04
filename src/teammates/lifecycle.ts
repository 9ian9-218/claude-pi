/**
 * lifecycle.ts — Teammate 生命周期（对齐 teammates/lifecycle.py）
 *
 * idle 通知、shutdown 协议（10：消息路径；protocol 注册归 11）、terminated 广播。
 */
import { TEAM_LEAD_NAME } from "./constants.ts";
import { sendStructuredMessage } from "./mailbox.ts";
import {
  createIdleNotification,
  createShutdownApproved,
  createShutdownRequest,
  createTeammateTerminated,
  parseStructured,
} from "./message-types.ts";
import { deactivateTeammate, getLeaderName, listActiveTeammates } from "./team-helpers.ts";

export async function sendIdleNotification(options: {
  agentName: string;
  teamName: string;
  summary?: string | null;
  idleReason?: string;
}): Promise<void> {
  const payload = createIdleNotification(
    options.agentName,
    options.idleReason ?? "available",
    options.summary ?? null,
  );
  const leader = getLeaderName(options.teamName);
  await sendStructuredMessage({
    fromAgent: options.agentName,
    toAgent: leader,
    payload,
    teamName: options.teamName,
  });
}

export async function sendShutdownRequest(options: {
  targetName: string;
  teamName: string;
  fromAgent?: string;
  reason?: string | null;
}): Promise<string> {
  const requestId = `shutdown-${Math.random().toString(16).slice(2, 14)}`;
  const payload = createShutdownRequest(
    requestId,
    options.fromAgent ?? TEAM_LEAD_NAME,
    options.reason ?? null,
  );
  await sendStructuredMessage({
    fromAgent: options.fromAgent ?? TEAM_LEAD_NAME,
    toAgent: options.targetName,
    payload,
    teamName: options.teamName,
  });
  return requestId;
}

/** Teammate 收到 shutdown_request → 回 shutdown_approved，返回 true */
export async function handleShutdownRequest(
  text: string,
  agentName: string,
  teamName: string,
): Promise<boolean> {
  const parsed = parseStructured(text);
  if (!parsed || parsed["type"] !== "shutdown_request") return false;

  const requestId = String(parsed["requestId"] ?? parsed["request_id"] ?? "");
  const leader = getLeaderName(teamName);
  const payload = createShutdownApproved(requestId, agentName);
  await sendStructuredMessage({
    fromAgent: agentName,
    toAgent: leader,
    payload,
    teamName,
  });
  console.log(`  \x1b[35m[protocol] ${agentName} approved shutdown (${requestId})\x1b[0m`);
  return true;
}

/** 广播 teammate_terminated 给 lead 与其余队友；停用成员 */
export async function notifyTeammateTerminated(options: {
  agentName: string;
  teamName: string;
  reason?: string | null;
}): Promise<void> {
  const payload = createTeammateTerminated(options.agentName, options.reason ?? null);
  const leader = getLeaderName(options.teamName);
  const recipients = new Set<string>([
    leader,
    ...listActiveTeammates(options.teamName).map((m) => m.name),
  ]);
  for (const recipient of recipients) {
    await sendStructuredMessage({
      fromAgent: "system",
      toAgent: recipient,
      payload,
      teamName: options.teamName,
    });
  }
  deactivateTeammate(options.teamName, options.agentName);
}
