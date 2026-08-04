# 运行时与 TUI 选型：Node.js 22 LTS + pi-tui（而非 Ink）

claude-pi 需要同时满足"学习 TS"与"结果能用"两个目标，因此运行时与 TUI 引擎的选择必须让 LLM SDK、MCP SDK、扩展加载、中文输入都零摩擦。选定 **Node.js 22 LTS** 作为运行时（Bun/Deno 在 TUI 与 npm 生态上有兼容风险，对常驻交互程序无启动速度收益），TUI 引擎选定 **`@earendil-works/pi-tui`**（v0.83，锁定版本）。

**Considered Options**: Ink（React 声明式，Claude Code 验证过）——因 CJK/IME 输入在 raw TTY 下是已知痛点、且引入 React + yoga-layout 原生二进制依赖而被否决；neo-blessed（停止维护）；手写 ANSI（工作量不可接受）；Bun/Deno（生态兼容风险）。

**Consequences**: TUI 层与 pi 同源，可互借组件与文档（docs/tui.md）；pi-tui 未到 1.0，须锁定版本并让核心 UI 逻辑与库解耦，便于未来升级或替换。
