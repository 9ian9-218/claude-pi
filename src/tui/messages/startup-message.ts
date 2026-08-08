/**
 * startup-message.ts — 启动帮助消息（10，对齐 pi onboarding）
 *
 * 默认折叠为一行提示；Ctrl+O 展开完整帮助（命令 + 键位表）；
 * /help 复用同一展开逻辑。
 */
import { Container, Text } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

const KEY_HINTS = [
  "Ctrl+O 折叠/展开工具输出与帮助",
  "Ctrl+T 折叠/展开 thinking",
  "Shift+Tab 切换思考强度",
  "Esc 中断生成",
  "Ctrl+C 清空输入框",
  "Ctrl+D 空输入退出",
  "Ctrl+L 模型选择器",
  "PgUp/PgDn 滚动聊天区",
];

const COMMANDS = [
  "/login 登录模型服务商",
  "/new 开新会话",
  "/tree 会话树导航",
  "/fork 从历史消息分叉",
  "/clone 克隆当前会话",
  "/resume 恢复历史会话",
  "/name 设置会话名",
  "/session 会话信息",
  "/model 切换模型",
  "/thinking 设置思考强度",
  "/status 显示状态",
  "/reload 重载扩展",
  "/help 显示帮助",
  "/quit 退出",
];

export class StartupMessageComponent extends Container {
  private text: Text;
  private expanded = false;
  private readonly oneLiner: string;

  constructor(oneLiner: string) {
    super();
    this.oneLiner = oneLiner;
    this.text = new Text(this.renderText(), 1, 0);
    this.addChild(this.text);
  }

  getText(): string {
    return this.oneLiner;
  }

  isExpanded(): boolean {
    return this.expanded;
  }

  setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    this.text.setText(this.renderText());
  }

  private renderText(): string {
    if (!this.expanded) {
      return theme.fg("dim", this.oneLiner);
    }
    const lines = [
      theme.fg("accent", theme.bold("claude-pi")),
      "",
      theme.fg("muted", "键位"),
      ...KEY_HINTS.map((k) => theme.fg("dim", `  ${k}`)),
      "",
      theme.fg("muted", "命令"),
      ...COMMANDS.map((c) => theme.fg("dim", `  ${c}`)),
      "",
      theme.fg("dim", "输入问题开始对话；Ctrl+O 折叠此帮助"),
    ];
    return lines.join("\n");
  }
}
