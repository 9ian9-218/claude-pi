---
title: "研究：顶层无崩溃兜底（uncaughtException 面）"
labels: ["wayfinder:research"]
parent: ../map.md
---

## Question

顶层**无** `process.on('uncaughtException'/'unhandledRejection')`。agent-loop 里所有 `await`（hook 回调、扩展代码、`summarizeHistory`、MCP 调用、teammates poller）一旦抛错：整进程带着未保存状态退出。实证：

1. 逐条确认抛错传播路径：hook(s) 抛错 → agent-loop 向谁传播；扩展代码抛错 → TUI 卡死还是崩溃；`compactHistory/summarizeHistory` 失败 → 会话丢失面（此时已落盘的部分）。
2. REPL/TUI/-p 三种模式的顶层异常行为差异（TUI 有 try/finally，REPL 没有）。
3. 修复候选：顶层兜底（记录 + 落盘 + 优雅退出）/ agent-loop 内层 try-catch 守卫 / hook 隔离执行——各自覆盖面和风险。

结论产出：崩溃面地图 + 推荐兜底方案（不实施）。

## Resolution

已实施：`src/fatal.ts`（installFatalHandlers）在 cli.ts main 顶部接入——顶层捕获
uncaughtException/unhandledRejection，打印原因 + 提示会话已落盘可恢复 + 退出码 1。
测试：子进程抛错 → 退出码 1 + stderr 含原因。
