/**
 * settings.ts — cpi 全局设置（~/.claude-pi/settings.json，独立配置）
 *
 * cpi 使用独立全局配置目录（默认 ~/.claude-pi，与 pi 的 ~/.pi/agent 分离；
 * PI_CODING_AGENT_DIR 仍可覆盖）。读写的键：retry（agent 级重试）、
 * defaultModel、enabledModels、compaction。
 * 文件缺失/损坏时回落默认值；提供从 ~/.pi/agent 的一次性迁移。
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
  /** 自动压缩（对齐 pi compaction 键：enabled/reserveTokens/keepRecentTokens） */
  compaction?: {
    enabled?: boolean;
    reserveTokens?: number;
    keepRecentTokens?: number;
    /** 触发系数（CC LA1=0.92 实证；触发 = kE ≥ pct × (window − maxOutput 预留)） */
    autoCompactPct?: number;
  };
}

/** pi 默认：agent 级重试开启，最多 3 次，指数退避 2s/4s/8s */
export const DEFAULT_RETRY: PiRetrySettings = { enabled: true, maxRetries: 3, baseDelayMs: 2000 };

/** pi 默认（DEFAULT_COMPACTION_SETTINGS）：window 余量 16K，tail 预算 20K；
 * autoCompactPct 对齐 CC 1.0.40 实证（LA1=0.92：kE ≥ 0.92×窗口触发） */
export const DEFAULT_COMPACTION: {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
  autoCompactPct: number;
} = {
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000,
  autoCompactPct: 0.92,
};

/** 从指定根目录加载默认配置引用（解耦 import）；cpi 独立配置位于 ~/.claude-pi */
let _cache: PiSettings | null = null;
let _override: PiSettings | null = null;

/**
 * cpi 全局配置目录（~/.claude-pi，PI_CODING_AGENT_DIR 可覆盖）。
 * 与 pi 不再共享（旧 pi 配置经 migrateFromPi 一次性迁移）。
 */
export function getAgentDir(): string {
  const envDir =
    process.env.PI_CODING_AGENT_DIR ?? process.env.TAU_CODING_AGENT_DIR;
  if (envDir) {
    return envDir.startsWith("~") ? path.join(os.homedir(), envDir.slice(1)) : envDir;
  }
  return path.join(os.homedir(), ".claude-pi");
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
    ...(parsed["compaction"] !== undefined
      ? {
          compaction: {
            enabled:
              (parsed["compaction"] as Record<string, unknown>)["enabled"] !== false,
            ...(typeof (parsed["compaction"] as Record<string, unknown>)["reserveTokens"] === "number"
              ? { reserveTokens: (parsed["compaction"] as Record<string, unknown>)["reserveTokens"] as number }
              : {}),
            ...(typeof (parsed["compaction"] as Record<string, unknown>)["keepRecentTokens"] === "number"
              ? {
                  keepRecentTokens: (parsed["compaction"] as Record<string, unknown>)["keepRecentTokens"] as number,
                }
              : {}),
            ...(typeof (parsed["compaction"] as Record<string, unknown>)["autoCompactPct"] === "number"
              ? {
                  autoCompactPct: (parsed["compaction"] as Record<string, unknown>)["autoCompactPct"] as number,
                }
              : {}),
          },
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

// ── 写入（/settings 设置页用）─────────────────────────────────────────────

/** 把设置合并写入全局 settings.json（保留既有键），成功后清缓存 */
export function writePiSettings(patch: Partial<PiSettings>): boolean {
  const current = readPiSettings();
  const merged: Record<string, unknown> = {};
  // patch 键级合并（retry/compaction 按完整对象替换，避免深层 merge 复杂度）
  for (const key of Object.keys(current) as Array<keyof PiSettings>) {
    merged[key] = current[key];
  }
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) merged[k] = v;
  }
  try {
    fs.mkdirSync(getAgentDir(), { recursive: true });
    fs.writeFileSync(getSettingsPath(), JSON.stringify(merged, null, 2) + "\n");
    resetSettingsCache();
    return true;
  } catch {
    return false;
  }
}

// ── 一次性迁移（~/.pi/agent → ~/.claude-pi）──────────────────────────────

const MIGRATABLE_FILES = ["auth.json", "models.json", "settings.json"] as const;

/** 需要迁移：旧目录存在配置且新目录缺失至少一个配置文件 */
export function migrateNeeded(fromDir: string, toDir: string): boolean {
  if (fromDir === toDir) return false;
  for (const f of MIGRATABLE_FILES) {
    if (fs.existsSync(path.join(fromDir, f)) && !fs.existsSync(path.join(toDir, f))) {
      return true;
    }
  }
  return false;
}

/**
 * 从旧 pi 配置目录复制缺失的配置文件到新目录。
 * 返回是否发生了复制；新目录已有同名文件时不覆盖。
 */
export function migrateFromPi(
  fromDir: string = path.join(os.homedir(), ".pi", "agent"),
  toDir: string = getAgentDir(),
): boolean {
  let copied = false;
  for (const f of MIGRATABLE_FILES) {
    const src = path.join(fromDir, f);
    const dst = path.join(toDir, f);
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      try {
        fs.mkdirSync(toDir, { recursive: true });
        fs.copyFileSync(src, dst);
        copied = true;
      } catch {
        // 复制失败：继续其余文件
      }
    }
  }
  resetSettingsCache();
  return copied;
}
