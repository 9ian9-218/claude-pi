/**
 * settings-commands.ts — TUI /settings 设置页（cpi 独立配置）
 *
 * 设置项分两层：
 * - 全局（~/.claude-pi/settings.json，不再与 pi 共享）：retry / compaction
 * - 项目级（.agent/config.json）：导出模式 export.mode
 * 风格对齐 pi settings：列表选择 → 值选择 → 即时写盘生效。
 */
import type { TuiApp } from "./app.ts";
import { readPiSettings, writePiSettings, getAgentDir, resetSettingsCache } from "../settings.ts";
import { getExportMode, setExportMode } from "../project-config.ts";
import type { ExportMode } from "../project-config.ts";

const EXPORT_MODES: Array<{ value: string; label: string; description: string }> = [
  {
    value: "analysis",
    label: "analysis（测试/分析）",
    description: "导出整棵树 + 每步耗时/token 明细，用于轨迹分析",
  },
  {
    value: "portable",
    label: "portable（会话移植）",
    description: "导出活动分支纯内容，供 /import 恢复会话",
  },
];

/** /settings 命令入口 */
export async function handleSettingsCommand(app: TuiApp): Promise<void> {
  const s = readPiSettings();
  const items = [
    {
      value: "export-mode",
      label: `导出模式（/export 默认）`,
      description: `当前：${getExportMode()}（analysis=整树+性能明细 / portable=分支纯内容）`,
    },
    {
      value: "retry",
      label: "自动重试（错误恢复）",
      description: `当前：${s.retry.enabled ? "开启" : "关闭"}（最多 ${s.retry.maxRetries} 次，退避 ${s.retry.baseDelayMs}ms）`,
    },
    {
      value: "compaction",
      label: "自动上下文压缩（L4）",
      description: `当前：${s.compaction?.enabled !== false ? "开启" : "关闭"}`,
    },
    {
      value: "config-info",
      label: "配置目录",
      description: getAgentDir(),
    },
  ];
  const picked = await app.showSelector(items, "Settings — 选择设置项");
  if (!picked) {
    app.appendMessage("system", "已取消。");
    return;
  }
  switch (picked.value) {
    case "export-mode": {
      const chosen = await app.showSelector(EXPORT_MODES, "导出模式（/export 默认）");
      if (!chosen) {
        app.appendMessage("system", "已取消。");
        return;
      }
      const mode = chosen.value as ExportMode;
      setExportMode(mode);
      resetSettingsCache();
      app.appendMessage("system", `导出模式已设为：${mode}（.agent/config.json）`);
      return;
    }
    case "retry": {
      const chosen = await app.showSelector(
        [
          { value: "on", label: "开启", description: "429/529 等错误按退避重试" },
          { value: "off", label: "关闭", description: "传输错误直接返回" },
        ],
        "自动重试",
      );
      if (!chosen) {
        app.appendMessage("system", "已取消。");
        return;
      }
      writePiSettings({ retry: { ...s.retry, enabled: chosen.value === "on" } });
      app.appendMessage("system", `自动重试已${chosen.value === "on" ? "开启" : "关闭"}（~/.claude-pi/settings.json）`);
      return;
    }
    case "compaction": {
      const chosen = await app.showSelector(
        [
          { value: "on", label: "开启", description: "上下文超阈值时 LLM 摘要压缩" },
          { value: "off", label: "关闭", description: "不自动压缩" },
        ],
        "自动上下文压缩（L4）",
      );
      if (!chosen) {
        app.appendMessage("system", "已取消。");
        return;
      }
      writePiSettings({ compaction: { ...s.compaction, enabled: chosen.value === "on" } });
      app.appendMessage("system", `自动压缩已${chosen.value === "on" ? "开启" : "关闭"}（~/.claude-pi/settings.json）`);
      return;
    }
    case "config-info":
      app.appendMessage("system", `全局配置目录：${getAgentDir()}\n项目配置：.agent/config.json（导出模式）`);
      return;
    default:
      app.appendSystem("未知设置项。", "warning");
  }
}