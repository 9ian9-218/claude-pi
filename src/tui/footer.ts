/**
 * footer.ts — 底部状态栏（对齐 pi footer，两行布局）
 *
 * 第 1 行：dim cwd (git branch)（branch 失败静默）。
 * 第 2 行：左 = 会话统计 `↑in ↓out RcacheRead WcacheWrite CH% $cost ctx%/window`（dim，
 * 上下文 % 按占用着色：>90% 红、>70% 黄）；右 = 模型名（右对齐）。
 * 统计由 statsProvider 渲染时现算（零状态，数据在会话 entry 上）。
 * agent-loop 运行时第 2 行前显示 Working spinner（pi-tui Loader 自带动画）。
 */
import { Container, Loader, Text, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { theme } from "./theme/theme.ts";
import type { FooterStats } from "../usage-stats.ts";

const SPINNER_FRAMES = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"];

/** 数字压缩：<1k 原样；<10k 一位小数；<100k 取整 k；<10M 一位小数 M；其余取整 M（pi 同款） */
export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

export class Footer extends Container {
  private info: Text;
  private stats: Text;
  private loader: Loader | null = null;
  private working = false;
  private model = "";
  private cwd = "";
  private statsProvider: (() => FooterStats | null) | null = null;
  private readonly tui: TUI;

  constructor(tui: TUI) {
    super();
    this.tui = tui;
    this.info = new Text("", 1, 0);
    this.stats = new Text("", 1, 0);
    this.addChild(this.info);
    this.addChild(this.stats);
  }

  /** 静态信息：模型名（右侧）、cwd（第 1 行） */
  setInfo(model: string, cwd: string): void {
    this.model = model;
    this.cwd = cwd;
    this.tui.requestRender();
  }

  /** 统计数据源注入（渲染时现算；null = 无会话 → 第 2 行只显示模型名） */
  setStatsProvider(provider: (() => FooterStats | null) | null): void {
    this.statsProvider = provider;
    this.tui.requestRender();
  }

  /** Working/空闲 状态切换；message 为 spinner 旁提示（如 "Working…"） */
  setWorking(working: boolean, message = "Working…"): void {
    if (this.working === working) return;
    this.working = working;
    if (working) {
      this.loader = new Loader(
        this.tui,
        (s) => theme.fg("accent", s),
        (s) => theme.fg("dim", s),
        message,
        { frames: SPINNER_FRAMES, intervalMs: 80 },
      );
      this.addChild(this.loader);
      this.loader.start();
    } else {
      this.loader?.stop();
      if (this.loader) {
        this.removeChild(this.loader);
      }
      this.loader = null;
    }
    this.tui.requestRender();
  }

  isWorking(): boolean {
    return this.working;
  }

  /** 测试用：取当前渲染文本（两行状态 + spinner 帧） */
  getText(): string {
    const width = (this.tui.terminal as { columns?: number } | undefined)?.columns ?? 80;
    return this.render(width).join("\n");
  }

  /** 基础统计部分（↑↓R W CH $，逐个 dim；上下文 % 由 render 单独着色追加） */
  private buildStatsLine(s: FooterStats): string[] {
    const parts: string[] = [];
    const t = s.totals;
    const dim = (x: string) => theme.fg("dim", x);
    if (t.input) parts.push(dim(`↑${formatTokens(t.input)}`));
    if (t.output) parts.push(dim(`↓${formatTokens(t.output)}`));
    if (t.cacheRead) parts.push(dim(`R${formatTokens(t.cacheRead)}`));
    if (t.cacheWrite) parts.push(dim(`W${formatTokens(t.cacheWrite)}`));
    if ((t.cacheRead > 0 || t.cacheWrite > 0) && s.latestCacheHitRate !== undefined) {
      parts.push(dim(`CH${s.latestCacheHitRate.toFixed(1)}%`));
    }
    if (t.cost) parts.push(dim(`$${t.cost.toFixed(3)}`));
    // 子 agent 编队：用量已并入上面的 ↑↓R W $，这里只标出数量与在跑数
    if (s.agents && s.agents.count > 0) {
      const running = s.agents.running > 0 ? ` ▶${s.agents.running}` : "";
      parts.push(dim(`A${s.agents.count}${running}`));
    }
    return parts;
  }

  render(width: number): string[] {
    const stats = this.statsProvider ? this.statsProvider() : null;
    const branch = stats?.branch ?? null;
    const cwdLine = branch ? `${this.cwd} (${branch})` : this.cwd;
    // 上下文 % 部分单独着色（>90% 红、>70% 黄），其余统计部分逐个 dim
    const statsParts = stats ? this.buildStatsLine(stats) : [];
    if (stats?.context) {
      const { percent, contextWindow } = stats.context;
      const display =
        percent === null
          ? `?/${formatTokens(contextWindow)}`
          : `${percent.toFixed(1)}%/${formatTokens(contextWindow)}`;
      statsParts.push(
        percent === null
          ? theme.fg("dim", display)
          : percent > 90
            ? theme.fg("error", display)
            : percent > 70
              ? theme.fg("warning", display)
              : theme.fg("dim", display),
      );
    }
    const statsText = statsParts.join(" ");
    const line1 = theme.fg(
      "dim",
      visibleWidth(cwdLine) > width ? truncateToWidth(cwdLine, width, "...") : cwdLine,
    );

    const modelText = theme.fg("muted", this.model);
    const statsWidth = visibleWidth(statsText);
    const modelWidth = visibleWidth(modelText);
    const total = statsWidth + modelWidth + 2;
    let line2: string;
    if (total <= width) {
      const pad = " ".repeat(width - statsWidth - modelWidth);
      line2 = theme.fg("dim", statsText) + pad + modelText;
    } else if (statsWidth < width - 2) {
      const avail = width - statsWidth - 2;
      line2 =
        theme.fg("dim", statsText) +
        "  " +
        (modelWidth > avail ? `${truncateToWidth(this.model, avail, "...")}` : modelText);
    } else {
      line2 = theme.fg("dim", truncateToWidth(statsText, width, "..."));
    }
    const loaderLines = this.working && this.loader ? this.loader.render(width) : [];
    return [line1, line2, ...loaderLines];
  }
}
