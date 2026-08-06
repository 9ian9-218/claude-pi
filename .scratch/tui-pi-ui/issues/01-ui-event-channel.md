# 01 — UI 事件通道

**What to build:** agent-loop 向 TUI 广播结构化 UI 事件的可选回调通道：thinking 流、工具开始/结果、回合结束状态，并支持 AbortSignal 中断生成。`LoopOptions` 增加 `signal` / `onToolEvent` / `onTurnEnd`，`onStream` 结构化为 `{ kind: "text"|"thinking", delta }`；`client.ts` 转发 thinking_delta 并透传 signal；`error-recovery.ts` 透传 signal 且用户中断时跳过 appendErrorMessage。不传回调时 print/json/REPL 行为与现在完全一致。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] onStream 结构化事件（text/thinking）在 client.ts 流式循环中正确发出
- [ ] AbortSignal 全链路透传：loop-options → agent-loop → error-recovery → client → pi-ai stream
- [ ] signal 中断时 error-recovery 不 appendErrorMessage、返回 abort，会话不落脏数据
- [ ] 工具调用前后各发一次 onToolEvent（start 带 name/id/args；result 带内容与 isError）
- [ ] 每回合结束发 onTurnEnd（stopReason/errorMessage）
- [ ] 既有单测更新绿灯（client/agent-loop/error-recovery 的 onStream 调用点）
