---
title: "决策：稳定性修复范围与优先级"
labels: ["wayfinder:grilling"]
parent: ../map.md
blocked_by: [01-sync-blocking-bash, 02-session-torn-line, 03-session-concurrent-writes, 04-process-crash-surface]
---

## Question

综合研究票 01（同步阻塞）、02（torn line）、03（跨进程并发）、04（崩溃面）的结论，逐项裁决：

- 每项修 / 不修 / 降级（如记录为已知限制）？
- 修复优先级排序（哪项先做、哪项可推迟）？
- 有冲突时取舍：如"torn line 容错 + truncateTo 重写"与"并发锁"的关系。

裁决输入：四张研究票的实证结论；`/grilling` + `/domain-modeling` 逐项对话，一张票一次会话。
