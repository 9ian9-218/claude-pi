---
title: "决策：分发就绪（打包、CI、工程基线）"
labels: ["wayfinder:grilling"]
parent: ../map.md
blocked_by: [05-distribution-packaging, 11-engineering-hygiene]
---

## Question

综合研究票 05（打包）与 11（工程化欠账）：

- 打包方案选型（tsx 升依赖 vs build 产物 vs 其他），包体积与冷启动取舍；
- CI 最小集（跑哪些测试）、lint/格式基线是否引入；
- 依赖 pin 策略（锁版本 vs 跟随）、发布流程是否本次范围内。

裁决输入：两张研究票的实证结论。
