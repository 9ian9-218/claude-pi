---
title: "决策：性能取舍"
labels: ["wayfinder:grilling"]
parent: ../map.md
blocked_by: [10-performance-context-rebuild]
---

## Question

综合研究票 10 的实测数据：

- buildSessionContext 全量重建 / truncateTo 整文件重写 / 流式增量落盘——哪些修、哪些接受（附阈值：多大的会话才算问题）；
- 优化与 02/03（torn line、并发）的耦合取舍。

裁决输入：研究票 10 的实测结论。
