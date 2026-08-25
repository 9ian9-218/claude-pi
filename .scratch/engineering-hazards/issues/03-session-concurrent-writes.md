---
title: "研究：跨进程并发写同一会话文件无锁"
labels: ["wayfinder:research"]
parent: ../map.md
---

## Question

会话文件**无锁**（`proper-lockfile` 只用于 teammates mailbox）。两个 `cpi` 进程（如 TUI + `-p` 脚本、或两个终端）同时 `continueRecent` 打开同一 JSONL：内存树各自分叉、append 交错、`truncateTo` 整文件重写会**抹掉另一进程的增量**。实证：

1. 现实的并发触发场景（并行 TUI + -p、后台脚本 + 交互）；GitHub issue 上 CC 对并行会话的处理。
2. truncateTo 整文件重写的丢数据窗口（进程 A 重写时进程 B 的 append 丢失）。
3. 修复候选：文件锁（复用 proper-lockfile）/ 冲突检测（文件 mtime 变化提示重载）/ 每进程独立会话文件——各自代价。

结论产出：并发冲突场景清单 + 推荐方案与侵入面（不实施）。

## Resolution

已实施：会话文件锁（`<会话>.lock`，wx 原子创建，pid 写入；仅按 pid 存活判 stale，
不按时间——长会话误杀会抹数据）。`truncateTo` 在并发时只回滚内存、不重写磁盘，
避免抹掉另一进程增量。测试：二次 open concurrent、磁盘保护、死 pid 抢占、退出清理。
失败方向安全：误判 busy 仅提示，绝不误判 stale 抹数据。
