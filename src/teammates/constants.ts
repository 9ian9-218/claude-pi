/** teammates 常量（对齐 src/teammates/constants.py） */
import { resolveAgentDirs, AGENT_ROOT } from "../config.ts";

export const TEAM_LEAD_NAME = "team-lead";
export const TEAMMATE_MESSAGE_TAG = "teammate-message";

/** Agent 配色（UI / 邮箱元数据） */
export const AGENT_COLORS = [
  "blue",
  "green",
  "yellow",
  "purple",
  "orange",
  "pink",
  "cyan",
  "red",
] as const;

// 轮询间隔（秒）
export const LEAD_INBOX_POLL_INTERVAL = 1.0;
export const WORKER_PERMISSION_POLL_INTERVAL = 0.5;

// Autonomous idle（11 接入；常量先行对齐）
export const TEAMMATE_IDLE_POLL_INTERVAL = 5.0;
export const TEAMMATE_IDLE_TIMEOUT = 60.0;
export const TEAMMATE_WORK_MAX_TURNS = 15;
export const TEAMMATE_IDENTITY_REINJECT_THRESHOLD = 3;

// 文件锁重试（proper-lockfile 语义）
export const LOCK_RETRIES = 10;
export const LOCK_MIN_TIMEOUT_MS = 5;
export const LOCK_MAX_TIMEOUT_MS = 100;

/** 测试可注入 teams 根目录 */
let teamsDir: string = resolveAgentDirs(AGENT_ROOT).teamsDir;

export function setTeamsDir(dir: string): void {
  teamsDir = dir;
}

export function getTeamsDir(): string {
  return teamsDir;
}
