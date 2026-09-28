/**
 * settings.ts — cpi 全局设置（~/.claude-pi/settings.json，独立配置）
 *
 * cpi 使用独立全局配置目录（默认 ~/.claude-pi，与 pi 的 ~/.pi/agent 分离；
 * PI_CODING_AGENT_DIR 仍可覆盖）。读写的键：retry（agent 级重试）、
 * defaultModel、enabledModels、compaction。
 * 文件缺失/损坏时回落默认值；提供从 ~/.pi/agent 的一次性迁移。
 */
import fs from "node:fs";
import { writeFileAtomic } from "./atomic-write.ts";
import os from "node:os";
import path from "node:path";

export interface PiRetrySettings {
  enabled: boolean;
  maxRetries: number;
  baseDelayMs: number;
}

export type TeamMode = "pipeline" | "free";

export interface TeamSettings {
  mode: TeamMode;
}

export interface PiSettings {
  retry: PiRetrySettings;
  defaultModel?: string;
  enabledModels?: string[];
  team?: TeamSettings;
  /** 记忆功能（默认开启）：关闭后不注入记忆、不做 Stop hook 提取 */
  memory?: {
    enabled?: boolean;
  };
  /**
   * 自动压缩。reserveTokens 不写则按模型真实窗口派生（compact.ts
   * COMPACTION_RATIOS）；keepRecentTokens 默认固定 20K；两个键都可用这里
   * 显式覆盖。
   */
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

/** 压缩默认：开关 + 触发系数 + **固定 20K** 的 retainedTail 预算（对齐 pi）。
 * 注意：这里曾有的 reserveTokens: 16384 从未被任何代码读取（实际预留走
 * compact.ts 的 maxOutputReserve，旧实现按模型名硬编码 8192/32000），故移除；
 * 输出预留现按模型窗口派生，需要时用 settings.compaction.reserveTokens 覆盖。 */
export const DEFAULT_COMPACTION = {
  enabled: true,
  autoCompactPct: 0.92,
  keepRecentTokens: 20_000,
} as const;

/** 配置缓存与测试覆盖（/settings 修改后 resetSettingsCache） */
let _cache: PiSettings | null = null;
let _override: PiSettings | null = null;

/** FROM 控注释：cpi 独立全局配置目录与旧 pi 配置目录的唯一事实源 */
export function defaultAgentDir(): string {
  return path.join(os.homedir(), ".claude-pi");
}

/** 旧 pi 全局配置目录（一次性迁移来源） */
export function legacyPiAgentDir(): string {
  return path.join(os.homedir(), ".pi", "agent");
}

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
  return defaultAgentDir();
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
  } catch (e) {
    // 文件不存在是正常情况；存在却解析失败要出声，否则用户以为设置生效了
    if (fs.existsSync(getSettingsPath())) {
      console.warn(
        `  \x1b[33m[settings] ${getSettingsPath()} 解析失败，本次使用默认设置：${String((e as Error)?.message ?? e)}\x1b[0m`,
      );
    }
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
    // team / memory 此前漏解析：getTeamMode() 与 isMemoryEnabled() 永远拿默认值，
    // 用户在 /settings 里按下的开关读不回来（写下去的值也读不到）
    ...(parsed["team"] !== undefined
      ? {
          team: {
            mode:
              (parsed["team"] as Record<string, unknown>)["mode"] === "pipeline" ? "pipeline" : "free",
          },
        }
      : {}),
    ...(parsed["memory"] !== undefined
      ? {
          memory: {
            enabled: (parsed["memory"] as Record<string, unknown>)["enabled"] !== false,
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
  // 以磁盘上的原始 JSON 为底稿：readPiSettings 是手写白名单解析，用它当底稿会把
  // 解析器不认识的键（含未来新增设置）从文件里抹掉
  let merged: Record<string, unknown> = {};
  try {
    merged = JSON.parse(fs.readFileSync(getSettingsPath(), "utf8")) as Record<string, unknown>;
  } catch {
    merged = {};
  }
  // patch 键级合并（retry/compaction 按完整对象替换，避免深层 merge 复杂度）
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) merged[k] = v;
  }
  try {
    fs.mkdirSync(getAgentDir(), { recursive: true });
    writeFileAtomic(getSettingsPath(), JSON.stringify(merged, null, 2) + "\n");
    resetSettingsCache();
    return true;
  } catch {
    return false;
  }
}

// ── 一次性迁移（~/.pi/agent → ~/.claude-pi）──────────────────────────────

const MIGRATABLE_FILES = ["auth.json", "models.json", "settings.json"] as const;

/** 旧目录中缺失于新目录的配置文件列表（空 = 无需迁移） */
function missingMigratableFiles(fromDir: string, toDir: string): string[] {
  return MIGRATABLE_FILES.filter((f) => {
    const src = path.join(fromDir, f);
    return fs.existsSync(src) && !fs.existsSync(path.join(toDir, f));
  });
}

/** 需要迁移：旧目录存在配置且新目录缺失至少一个配置文件 */
export function migrateNeeded(fromDir: string, toDir: string): boolean {
  if (fromDir === toDir) return false;
  return missingMigratableFiles(fromDir, toDir).length > 0;
}

/**
 * 从旧 pi 配置目录复制缺失的配置文件到新目录。
 * 返回是否发生了复制；新目录已有同名文件时不覆盖。
 */
export function migrateFromPi(
  fromDir: string = legacyPiAgentDir(),
  toDir: string = getAgentDir(),
): boolean {
  const missing = missingMigratableFiles(fromDir, toDir);
  for (const f of missing) {
    try {
      fs.mkdirSync(toDir, { recursive: true });
      fs.copyFileSync(path.join(fromDir, f), path.join(toDir, f));
    } catch {
      // 复制失败：继续其余文件
    }
  }
  resetSettingsCache();
  return missing.length > 0;
}


/** 记忆功能开关（默认开启） */
export function isMemoryEnabled(): boolean {
  return readPiSettings().memory?.enabled !== false;
}

export function getTeamMode(): TeamMode {
  const s = readPiSettings();
  // 默认 free：pipeline 预设会强制角色委派（lead 不能自己写文件/跑命令），
  // 必须是显式 opt-in，否则所有既有用法会被默认改行为
  return s.team?.mode ?? "free";
}

export function setTeamMode(mode: TeamMode): void {
  const current = readPiSettings();
  writePiSettings({
    team: {
      ...current.team,
      mode,
    },
  });
}
