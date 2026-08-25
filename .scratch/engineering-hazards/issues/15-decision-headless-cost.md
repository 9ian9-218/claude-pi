---
title: "决策：无头健壮性与成本防护"
labels: ["wayfinder:grilling"]
parent: ../map.md
blocked_by: [08-headless-robustness, 09-context-cost-control]
---

## Question

综合研究票 08（无头失败面）与 09（上下文/费用失控）：

- 无头模式的权限默认行为与退出码契约是否本次修复（对齐 CC 的程度）；
- 重试 watchdog / 跨轮预算 / 工具循环检测中，哪些进修复范围、什么阈值；
- CC 对照项（流停滞看门狗、降 max_tokens、部分输出保留）的取舍。

裁决输入：两张研究票的实证结论 + `docs/research/claude-code-error-recovery.md` 对照。

## 前置注记（2025-08-25）

TUI footer 两行统计已落地（grill 会话共识：Q1–Q8 全量复制 pi footer）：
usage 落盘（assistant/compaction entry）→ 渲染时现算纯函数（usage-stats.ts）→
footer 显示 ↑↓R W CH% $ 上下文%/窗口（压缩后 ? 态）。本票决策时可引用。
