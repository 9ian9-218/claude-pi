/**
 * footer.ts — 底部状态栏（07，对齐 pi footer）
 *
 * 布局：claude-pi · 模型 · cwd；agent-loop 运行时显示 Working spinner
 * （pi-tui Loader 自带动画），空闲时静默。
 */
import { Container, Loader, Text, type TUI } from "@earendil-works/pi-tui";
import { theme } from "./theme/theme.ts";

const SPINNER_FRAMES = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"];

export class Footer extends Container {
  private info: Text;
  private loader: Loader | null = null;
  private working = false;
  private readonly tui: TUI;

  constructor(tui: TUI) {
    super();
    this.tui = tui;
    this.info = new Text("", 1, 0);
    this.addChild(this.info);
  }

  /** 静态信息：claude-pi · 模型 · cwd */
  setInfo(model: string, cwd: string): void {
    const parts = [
      theme.fg("accent", theme.bold("claude-pi")),
      theme.fg("muted", model),
      theme.fg("dim", cwd),
    ];
    this.info.setText(parts.join(" · "));
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

  /** 测试用：取当前渲染文本（含 spinner 帧） */
  getText(): string {
    return this.children.map((c) => ((c as { text?: string }).text ?? "")).join(" ");
  }
}
