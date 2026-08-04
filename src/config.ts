/**
 * config.ts — 共享运行时配置（对齐 src/config.py）
 *
 * 运行时数据根为项目内 .agent/（ADR-0004/0005：不写用户目录，
 * 与 Python 版 .claude/ 对应，目录名去 Claude 化）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 仓库根（src/ 的父目录；包解析用） */
export const PROJECT_ROOT: string = path.resolve(__dirname, "..");

/** 当前工作目录（进程启动时确定） */
export const WORKDIR: string = process.cwd();

/**
 * 数据根（.agent/ 所在目录）：跟随 cwd——全局 cpi 在哪个项目运行，
 * 数据就落在哪个项目（CLAUDE_PI_AGENT_ROOT 可覆盖）。
 */
export const AGENT_ROOT: string = process.env.CLAUDE_PI_AGENT_ROOT ?? process.cwd();

/** .agent 数据根下的全部运行时目录（对齐 CONTEXT.md「.agent/ 数据根」） */
export interface AgentDirs {
  agentsDir: string;
  teamsDir: string;
  memoryDir: string;
  tasksDir: string;
  skillsDir: string;
  worktreesDir: string;
  sessionsDir: string;
  extensionsDir: string;
}

export function resolveAgentDirs(root: string): AgentDirs {
  const agentsDir = path.join(root, ".agent");
  return {
    agentsDir,
    teamsDir: path.join(agentsDir, "teams"),
    memoryDir: path.join(agentsDir, "memory"),
    tasksDir: path.join(agentsDir, "tasks"),
    skillsDir: path.join(agentsDir, "skills"),
    worktreesDir: path.join(agentsDir, "worktrees"),
    sessionsDir: path.join(agentsDir, "sessions"),
    extensionsDir: path.join(agentsDir, "extensions"),
  };
}

/** 确保 .agent 目录树存在（幂等），返回目录映射 */
export function ensureAgentDirs(root: string = AGENT_ROOT): AgentDirs {
  const dirs = resolveAgentDirs(root);
  for (const d of Object.values(dirs)) {
    fs.mkdirSync(d, { recursive: true });
  }
  return dirs;
}

/** 从指定根目录加载 .env（不存在则静默跳过；不覆盖已存在的环境变量） */
export function loadEnvFile(root: string = PROJECT_ROOT): void {
  dotenv.config({ path: path.join(root, ".env"), override: false });
}

/** 布尔环境变量解析（对齐 Python 版 _env_bool：1/true/yes/on） */
export function envBool(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === null) return defaultValue;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

/** Tool calling strict 模式开关（OPENAI_TOOL_STRICT，默认开启） */
export function getToolStrict(): boolean {
  return envBool("OPENAI_TOOL_STRICT", true);
}

/** 启动时一次性初始化：加载 .env 并确保数据目录存在 */
export function initRuntime(root: string = AGENT_ROOT): AgentDirs {
  loadEnvFile(root);
  return ensureAgentDirs(root);
}
