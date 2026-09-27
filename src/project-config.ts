/**
 * project-config.ts — 项目级配置（.agent/config.json）
 *
 * 与用户级全局配置（~/.claude-pi/settings.json，见 settings.ts）分离：
 * 项目相关的设置（如导出模式 export.mode）落在 .agent/ 数据根下，
 * 随项目走、不写用户目录（对齐「数据根跟随项目」）。
 */
import fs from "node:fs";
import { writeFileAtomic } from "./atomic-write.ts";
import { resolveAgentDirs } from "./config.ts";
import path from "node:path";
import { AGENT_ROOT } from "./config.ts";

export type ExportMode = "analysis" | "portable";

export interface ProjectConfig {
  /** 会话导出配置（/export 默认行为） */
  export?: {
    mode?: ExportMode;
  };
  [key: string]: unknown;
}

export const DEFAULT_EXPORT_MODE: ExportMode = "analysis";

let cfgRoot: string | null = null;

/** 测试隔离：注入配置根（null = 默认 AGENT_ROOT） */
export function setProjectConfigRootForTest(root: string | null): void {
  cfgRoot = root;
}

export function getProjectConfigPath(): string {
  return path.join(resolveAgentDirs(cfgRoot ?? AGENT_ROOT).agentsDir, "config.json");
}

export function readProjectConfig(): ProjectConfig {
  try {
    const parsed = JSON.parse(fs.readFileSync(getProjectConfigPath(), "utf8")) as ProjectConfig;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    // 缺失/损坏 → 默认
    return {};
  }
}

/** 合并写入（保留既有键）；写失败静默（配置非关键路径，不阻断会话） */
export function writeProjectConfig(patch: ProjectConfig): boolean {
  const merged = { ...readProjectConfig(), ...patch };
  try {
    fs.mkdirSync(path.dirname(getProjectConfigPath()), { recursive: true });
    writeFileAtomic(getProjectConfigPath(), JSON.stringify(merged, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}

/** 当前导出模式（非法值回退默认 analysis） */
export function getExportMode(): ExportMode {
  const mode = readProjectConfig().export?.mode;
  return mode === "portable" ? "portable" : DEFAULT_EXPORT_MODE;
}

/** 设置导出模式（写项目配置） */
export function setExportMode(mode: ExportMode): boolean {
  return writeProjectConfig({ export: { mode } });
}