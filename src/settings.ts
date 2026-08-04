/**
 * settings.ts — pi 全局设置读取（~/.pi/agent/settings.json，ADR-0007）
 *
 * 只读 claude-pi 用到的键：retry（agent 级重试）、defaultModel、enabledModels。
 * 与 pi 共享同一文件；文件缺失/损坏时回落 pi 默认值。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface PiRetrySettings {
  enabled: boolean;
  maxRetries: number;
  baseDelayMs: number;
}

export interface PiSettings {
  retry: PiRetrySettings;
  defaultModel?: string;
  enabledModels?: string[];
}

/** pi 默认：agent 级重试开启，最多 3 次，指数退避 2s/4s/8s */
export const DEFAULT_RETRY: PiRetrySettings = { enabled: true, maxRetries: 3, baseDelayMs: 2000 };

let _cache: PiSettings | null = null;
let _override: PiSettings | null = null;

/**
 * pi 全局配置目录（~/.pi/agent，PI_CODING_AGENT_DIR 可覆盖）。
 * 与 pi 的 getAgentDir() 等价但本地实现——避免启动时引入 pi-coding-agent
 * 的巨大模块图（懒加载原则）。
 */
export function getAgentDir(): string {
  const envDir =
    process.env.PI_CODING_AGENT_DIR ?? process.env.TAU_CODING_AGENT_DIR;
  if (envDir) {
    return envDir.startsWith("~") ? path.join(os.homedir(), envDir.slice(1)) : envDir;
  }
  return path.join(os.homedir(), ".pi", "agent");
}

export function getSettingsPath(): string {
  return path.join(getAgentDir(), "settings.json");
}

export function readPiSettings(): PiSettings {
  if (_override !== null) return _override;
  if (_cache !== null) return _cache;
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(fs.readFileSync(getSettingsPath(), "utf8"));
  } catch {
    // 缺失/损坏 → 默认值
  }
  const retryRaw = (parsed["retry"] ?? {}) as Record<string, unknown>;
  const retry: PiRetrySettings = {
    enabled: retryRaw["enabled"] !== false,
    maxRetries:
      typeof retryRaw["maxRetries"] === "number" ? retryRaw["maxRetries"] : DEFAULT_RETRY.maxRetries,
    baseDelayMs:
      typeof retryRaw["baseDelayMs"] === "number" ? retryRaw["baseDelayMs"] : DEFAULT_RETRY.baseDelayMs,
  };
  const settings: PiSettings = {
    retry,
    ...(typeof parsed["defaultModel"] === "string"
      ? { defaultModel: parsed["defaultModel"] as string }
      : {}),
    ...(Array.isArray(parsed["enabledModels"])
      ? {
          enabledModels: (parsed["enabledModels"] as unknown[]).filter(
            (v): v is string => typeof v === "string",
          ),
        }
      : {}),
  };
  _cache = settings;
  return settings;
}

/** 测试隔离：注入/清除设置覆盖 */
export function setSettingsOverrideForTest(settings: PiSettings | null): void {
  _override = settings;
  _cache = null;
}

/** 清除缓存（resetClient 调用；/settings 修改后也应调用） */
export function resetSettingsCache(): void {
  _cache = null;
}
