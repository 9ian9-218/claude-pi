/**
 * agent-panel.ts — 输入框上方的多 agent 折叠面板
 *
 * 折叠（默认）：一行汇总 + 每个 agent 一行（状态 / 角色 / 轮数 / 工具数 / 最近工具）。
 * 展开（Ctrl+A）：追加任务目标、最近文本预览、结果摘要、子会话文件名。
 * 数据源是 agent-registry（订阅式）；没有 agent 时渲染为空，不占行。
 */
import { Container, Text } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { listAgentRuns, subscribeAgentRuns, type AgentRun } from "../../agent-registry.ts";
import { formatTokens } from "../footer.ts";

/** 折叠时最多列出的 agent 行数（其余折叠成一行提示） */
export const AGENT_PANEL_MAX_ROWS = 5;
/** 展开时最多列出的 agent 数 */
export const AGENT_PANEL_MAX_EXPANDED = 3;
const PREVIEW_CHARS = 120;
const RESULT_CHARS = 200;

const STATUS_ICON: Record<AgentRun["status"], string> = {
  running: "⣾",
  done: "✓",
  failed: "✗",
};

function shorten(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function fileName(file: string): string {
  const parts = file.split("/");
  return parts[parts.length - 1] ?? file;
}

export class AgentPanelComponent extends Container {
  private readonly text: Text;
  private readonly onRender: () => void;
  private expanded = false;
  private unsubscribe: (() => void) | null = null;

  constructor(onRender: () => void = () => {}) {
    super();
    this.onRender = onRender;
    this.text = new Text("", 1, 0);
    this.addChild(this.text);
    this.unsubscribe = subscribeAgentRuns(() => this.refresh());
    this.refresh();
  }

  /** 解绑注册表订阅（TuiApp.stop 调用） */
  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  toggle(): void {
    this.expanded = !this.expanded;
    this.refresh();
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    this.refresh();
  }

  isExpanded(): boolean {
    return this.expanded;
  }

  /** 当前注册表中的 agent 数（测试/命令用） */
  agentCount(): number {
    return listAgentRuns().length;
  }

  /** 面板文本（空串 = 不占行） */
  getText(): string {
    return this.lastText;
  }

  refresh(): void {
    this.lastText = this.buildText();
    this.text.setText(this.lastText);
    this.onRender();
  }

  private lastText = "";

  private buildText(): string {
    const runs = listAgentRuns();
    if (runs.length === 0) return "";

    const running = runs.filter((r) => r.status === "running").length;
    const done = runs.filter((r) => r.status === "done").length;
    const failed = runs.filter((r) => r.status === "failed").length;
    const parts = [`运行 ${running}`, `完成 ${done}`];
    if (failed > 0) parts.push(`失败 ${failed}`);
    const head = `${runs.length} 个 agent（${parts.join(" / ")}）`;
    const hint = this.expanded ? "Ctrl+A 折叠" : "Ctrl+A 展开";
    const marker = this.expanded ? "▾" : "▸";
    const lines = [theme.bold(`${marker} ${head} · ${hint}`)];

    const limit = this.expanded ? AGENT_PANEL_MAX_EXPANDED : AGENT_PANEL_MAX_ROWS;
    const visible = runs.slice(-limit);
    for (const run of visible) lines.push(...this.renderRun(run));

    if (runs.length > visible.length) {
      lines.push(theme.fg("dim", `  …另有 ${runs.length - visible.length} 个子 agent`));
    }
    return lines.join("\n");
  }

  private renderRun(run: AgentRun): string[] {
    const icon = STATUS_ICON[run.status] ?? "•";
    const meta = `${run.turns} 轮 / ${run.toolCalls} 工具`;
    const tool = run.lastTool ? ` · ${run.lastTool}` : "";
    // 持久 agent（teammate）才有阶段：working / idle；一次性 subagent 为空
    const phase = run.phase === "idle" ? " · 空闲" : run.phase === "working" ? " · 执行中" : "";
    const cost = run.usage && run.usage.cost > 0 ? ` · $${run.usage.cost.toFixed(4)}` : "";
    const title = `${icon} ${run.id} · ${meta}${tool}${cost}${phase}`;

    const styled =
      run.status === "failed"
        ? theme.fg("error", `  ${title}`)
        : run.status === "running"
          ? theme.fg("accent", `  ${title}`)
          : theme.fg("success", `  ${title}`);

    if (!this.expanded) return [styled];

    const lines = [styled];
    lines.push(theme.fg("dim", `    任务: ${run.label}`));
    if (run.usage) {
      const u = run.usage;
      lines.push(
        theme.fg(
          "dim",
          `    用量: ↑${formatTokens(u.input)} ↓${formatTokens(u.output)} R${formatTokens(u.cacheRead)} W${formatTokens(u.cacheWrite)} $${u.cost.toFixed(4)}`,
        ),
      );
    }
    if (run.sessionFile) {
      lines.push(theme.fg("dim", `    子会话: ${fileName(run.sessionFile)}`));
    }
    if (run.firstTurnCache) {
      const { cacheRead, cacheWrite } = run.firstTurnCache;
      // cacheRead > 0 ⇒ fork 的前缀被复用（父会话缓存命中）
      lines.push(
        theme.fg(
          "dim",
          `    首轮缓存: R${formatTokens(cacheRead)} W${formatTokens(cacheWrite)}` +
            (cacheRead > 0 ? "（已复用父前缀）" : "（未命中父前缀）"),
        ),
      );
    }
    if (run.lastText) {
      lines.push(theme.fg("dim", `    最近: ${shorten(run.lastText, PREVIEW_CHARS)}`));
    }
    if (run.endReason) {
      lines.push(theme.fg("dim", `    结束: ${shorten(run.endReason, PREVIEW_CHARS)}`));
    }
    if (run.result) {
      lines.push(theme.fg("dim", `    结果: ${shorten(run.result, RESULT_CHARS)}`));
    }
    if (run.error) {
      lines.push(theme.fg("error", `    错误: ${shorten(run.error, PREVIEW_CHARS)}`));
    }
    return lines;
  }
}