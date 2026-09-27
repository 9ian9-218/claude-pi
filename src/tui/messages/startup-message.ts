/**
 * startup-message.ts — 启动帮助消息（10，对齐 pi onboarding）
 *
 * 默认折叠为一行提示；Ctrl+O 展开完整帮助（命令 + 键位表）；
 * /help 复用同一展开逻辑。
 */
import { Container, Text } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { listCommandEntries } from "../../commands.ts";

const KEY_HINTS = [
  "Ctrl+O 折叠/展开工具输出与帮助",
  "Ctrl+A 展开/折叠子 agent 面板（输入框上方）",
  "Ctrl+T 折叠/展开 thinking",
  "Shift+Tab 切换思考强度",
  "Esc 中断生成",
  "Ctrl+C 清空输入框",
  "Ctrl+D 空输入退出",
  "Ctrl+L 模型选择器",
  "PgUp/PgDn 滚动聊天区",
];

/**
 * 命令清单：从命令目录派生（单一事实源），不再手抄。
 * 顺序 = 内置 → 会话 → 扩展，组内按名字排序。
 */
function commandLines(): string[] {
  const order: Record<string, number> = { builtin: 0, session: 1, extension: 2 };
  return [...listCommandEntries()]
    .sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9) || a.name.localeCompare(b.name))
    .map((c) => `/${c.name} ${c.description}`);
}

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
      ...commandLines().map((c) => theme.fg("dim", `  ${c}`)),
      "",
      theme.fg("dim", "输入问题开始对话；Ctrl+O 折叠此帮助"),
    ];
    return lines.join("\n");
  }
}
