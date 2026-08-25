---
title: "研究：性能（上下文全量重建、truncateTo 整文件重写、流式不落盘）"
labels: ["wayfinder:research"]
parent: ../map.md
---

## Question

性能面实证（分发后体感）：

1. 每次 user prompt `buildSessionContext()` 全量回溯分支 + 拷贝 messages；长会话（100 轮 + 大工具结果落盘预览）的耗时/内存实测。
2. `truncateTo` 整文件同步重写：大会话文件（数十 MB）下中断回滚的冻结时长；优化候选（append 删除标记 vs 重写）。
3. 流式响应不增量落盘：长文本回合中途崩溃丢整轮响应（已记录在 docs/research），增量落盘的代价（碎行、协议裁剪交互）。
4. `estimateMessagesTokens` 启发式（字符/token 比例）的偏差对 L4 触发的误判面。

结论产出：瓶颈实测数据 + 优化候选与代价排序（不实施）。

## ADR 边界

ADR-0004 原语义 "mid-turn 未完成回合不落盘"——已被既有改动演进（每步落盘 +
truncateTo 回滚 + closeOpenTurns 裁剪，CONTEXT.md 已更新）。结论请分两出口：
- **哲学内解**：buildSessionContext 重建优化、truncateTo 重写优化（不碰落盘粒度）
- **哲学外解**：流式字节级增量落盘 = 落盘粒度再演进（消息级 → 流片级），需决策票表态

