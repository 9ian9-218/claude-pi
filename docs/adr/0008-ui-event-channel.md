# ADR-0008 — UI 事件通道契约

**状态：** 已接受

**日期：** 2025-08

## 背景

TUI 重写为 pi 风格组件化界面（消息块/工具执行块/thinking 块/中断）需要核心循环向 UI 广播比现有 `onStream(text)` 更丰富的事件：thinking 流、工具开始/结果、回合结束状态（stopReason/errorMessage）、以及用户中断信号。曾在三个方案间取舍：

- **A（选定）**：`LoopOptions` 增加可选回调与可选 signal，agent-loop/client/error-recovery 只透传，不改变任何控制流。
- **B**：复用 onStream，用结构化标记包裹工具事件。破坏文本流的连续性，解析脆弱。
- **C**：TUI 直接 hook 底层 pi-ai 流。侵入传输层，UI 与模型层耦合。

## 决策

核心机制通过**可选回调**向 UI 广播事件，核心逻辑不感知 UI 的存在：

- `onStream(e: { kind: "text"|"thinking"; delta: string })` — 结构化流式内容（原 `(text: string)` 签名升级）
- `onToolEvent(e: { phase: "start"|"result"; name; id; args; result?; isError? })` — 工具执行块状态
- `onTurnEnd(e: { stopReason?; errorMessage? })` — 回合结束状态
- `signal?: AbortSignal` — 用户中断（Esc）；中断时 error-recovery 跳过 appendErrorMessage，不落脏数据

不传任何回调时，print/json/REPL 行为与改造前完全一致。

## 后果

- 核心机制（loop 逻辑、会话、hook、权限）零行为变化；测试通过不传回调保持原语义。
- UI 获得与 pi 对等的渲染数据源；后续新增 UI 元素无需再改核心。
- `onStream` 签名是破坏性变更，所有调用点（agent-loop/error-recovery/cli/测试）随本 ADR 一次性迁移。
