/**
 * mailbox.ts — 队友邮箱（对齐 teammates/mailbox.py）
 *
 * .agent/teams/{team}/inboxes/{agent}.json 为 JSON 数组；写入经文件锁
 * （proper-lockfile，格式与 Python 版字节兼容）。
 */
import fs from "node:fs";
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

export function readMailbox(agentName: string, teamName: string): MailboxMessage[] {
  const inboxPath = getInboxPath(agentName, teamName);
  if (!fs.existsSync(inboxPath)) return [];
  try {
    const messages = JSON.parse(fs.readFileSync(inboxPath, "utf8"));
    return Array.isArray(messages) ? messages : [];
  } catch {
    return [];
  }
}

export function readUnreadMessages(agentName: string, teamName: string): MailboxMessage[] {
  return readMailbox(agentName, teamName).filter((m) => !m.read);
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
    fs.writeFileSync(inboxPath, "[]");
  }

  await withFileLock(lockPath, () => {
    const messages = readMailbox(recipientName, teamName);
    const newMessage: MailboxMessage = {
      ...message,
      read: false,
      timestamp: message.timestamp ?? new Date().toISOString(),
    };
    messages.push(newMessage);
    fs.writeFileSync(inboxPath, JSON.stringify(messages, null, 2));
  });
}

export async function markMessagesAsRead(agentName: string, teamName: string): Promise<void> {
  const inboxPath = getInboxPath(agentName, teamName);
  const lockPath = `${inboxPath}.lock`;
  if (!fs.existsSync(inboxPath)) return;
  await withFileLock(lockPath, () => {
    const messages = readMailbox(agentName, teamName);
    for (const m of messages) m.read = true;
    fs.writeFileSync(inboxPath, JSON.stringify(messages, null, 2));
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
    fs.writeFileSync(inboxPath, JSON.stringify(messages, null, 2));
  });
}

export function clearMailbox(agentName: string, teamName: string): void {
  const inboxPath = getInboxPath(agentName, teamName);
  if (fs.existsSync(inboxPath)) {
    fs.writeFileSync(inboxPath, "[]");
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
