---
title: "研究：工程化欠账（CI、lint、依赖 pin、发布流程）"
labels: ["wayfinder:research"]
parent: ../map.md
---

## Question

工程化基线盘点：

1. 无 CI（无 .github/workflows）；测试 56 文件/484 用例但无覆盖率门槛——CI 应该跑什么。
2. 无 lint/format 配置（无 eslint/prettier）；tsconfig 严格度现状。
3. 依赖 pin 策略：`@earendil-works/pi-ai` 等锁 0.83.0 exact，其余 `^`；pi-ai 快速迭代的升级面（breaking 成本）与 supply chain（jiti/MCP SDK 审计面）。
4. 发布流程：无 version/release 脚本、无 changelog、无 npm auth 说明；`docs/research/` 与 `.scratch/` 是否应进发行包。
5. 基准：同规模 TS 分发项目的工程基线（CI 最小集）。

结论产出：缺口清单 + 建议基线（不实施）。
