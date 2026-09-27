/**
 * mailbox.ts — 队友邮箱（对齐 teammates/mailbox.py）
 *
 * .agent/teams/{team}/inboxes/{agent}.json 为 JSON 数组；写入经文件锁
 * （proper-lockfile，格式与 Python 版字节兼容）。
 */
import fs from "node:fs";
import { writeFileAtomic } from "../atomic-write.ts";
import path from "node:path";
import { getTeamsDir } from "./constants.ts";
import { withFileLock } from "../file-lock.ts";

export interface MailboxMessage {
  from: string;
  text: string;
  color?: string | null;
  summary?: string | null;
  read?: boolean;
  timestamp?: string;
  [k: string]: unknown;
}

export function sanitizePathComponent(name: string): string {
  const safe = name.replace(/[^\w\-.@]+/g, "-").trim();
  return safe || "agent";
}

export function getInboxPath(agentName: string, teamName: string): string {
  const safeTeam = sanitizePathComponent(teamName);
  const safeAgent = sanitizePathComponent(agentName);
  return path.join(getTeamsDir(), safeTeam, "inboxes", `${safeAgent}.json`);
}

export function ensureInboxDir(teamName: string): string {
  const inboxDir = path.join(getTeamsDir(), sanitizePathComponent(teamName), "inboxes");
  fs.mkdirSync(inboxDir, { recursive: true });
  return inboxDir;
}

/** 已告警过的损坏收件箱（避免每秒轮询刷屏） */
const warnedCorrupt = new Set<string>();

export function readMailbox(agentName: string, teamName: string): MailboxMessage[] {
  const inboxPath = getInboxPath(agentName, teamName);
  if (!fs.existsSync(inboxPath)) return [];
  try {
    const messages = JSON.parse(fs.readFileSync(inboxPath, "utf8"));
    return Array.isArray(messages) ? messages : [];
  } catch (e) {
    // 损坏时静默当空 = 静默丢消息；轮询每秒读一次，故每个路径只报一次
    if (!warnedCorrupt.has(inboxPath)) {
      warnedCorrupt.add(inboxPath);
      console.warn(
        `  \x1b[33m[mailbox] ${inboxPath} 解析失败，已按空收件箱处理：${String((e as Error)?.message ?? e)}\x1b[0m`,
      );
    }
    return [];
  }
}


export async function writeToMailbox(
  recipientName: string,
  message: MailboxMessage,
  teamName: string,
): Promise<void> {
  ensureInboxDir(teamName);
  const inboxPath = getInboxPath(recipientName, teamName);
  const lockPath = `${inboxPath}.lock`;

  if (!fs.existsSync(inboxPath)) {
    writeFileAtomic(inboxPath, "[]");
  }

  await withFileLock(lockPath, () => {
    const messages = readMailbox(recipientName, teamName);
    const newMessage: MailboxMessage = {
      ...message,
      read: false,
      timestamp: message.timestamp ?? new Date().toISOString(),
    };
    messages.push(newMessage);
    writeFileAtomic(inboxPath, JSON.stringify(messages, null, 2));
  });
}

export async function markMessagesAsRead(agentName: string, teamName: string): Promise<void> {
  const inboxPath = getInboxPath(agentName, teamName);
  const lockPath = `${inboxPath}.lock`;
  if (!fs.existsSync(inboxPath)) return;
  await withFileLock(lockPath, () => {
    const messages = readMailbox(agentName, teamName);
    for (const m of messages) m.read = true;
    writeFileAtomic(inboxPath, JSON.stringify(messages, null, 2));
  });
}

export async function markMessageAsReadByIndex(
  agentName: string,
  teamName: string,
  messageIndex: number,
): Promise<void> {
  const inboxPath = getInboxPath(agentName, teamName);
  const lockPath = `${inboxPath}.lock`;
  if (!fs.existsSync(inboxPath)) return;
  await withFileLock(lockPath, () => {
    const messages = readMailbox(agentName, teamName);
    if (messageIndex < 0 || messageIndex >= messages.length) return;
    messages[messageIndex].read = true;
    writeFileAtomic(inboxPath, JSON.stringify(messages, null, 2));
  });
}

export function clearMailbox(agentName: string, teamName: string): void {
  const inboxPath = getInboxPath(agentName, teamName);
  if (fs.existsSync(inboxPath)) {
    writeFileAtomic(inboxPath, "[]");
  }
}

export async function sendPlainMessage(options: {
  fromAgent: string;
  toAgent: string;
  text: string;
  teamName: string;
  color?: string | null;
  summary?: string | null;
}): Promise<void> {
  await writeToMailbox(
    options.toAgent,
    {
      from: options.fromAgent,
      text: options.text,
      color: options.color ?? null,
      summary: options.summary ?? null,
    },
    options.teamName,
  );
}

export async function sendStructuredMessage(options: {
  fromAgent: string;
  toAgent: string;
  payload: Record<string, unknown>;
  teamName: string;
  color?: string | null;
}): Promise<void> {
  await writeToMailbox(
    options.toAgent,
    {
      from: options.fromAgent,
      text: JSON.stringify(options.payload),
      color: options.color ?? null,
    },
    options.teamName,
  );
}
