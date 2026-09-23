---
title: "研究：上下文与费用失控面"
labels: ["wayfinder:research"]
parent: ../map.md
---

## Question

Agent 循环的失控保护边界：loop 上限 100 轮、单次 max_tokens 8K→64K 升级——但**无跨轮 token/费用预算**、**无工具循环检测**（同一工具/同一参数反复调用无进展）、compact 失败路径未验证。实证：

1. 一轮工具循环中 budget 上限（L3 出口截断/落盘 + L4 压缩阈值）合计 token 上限估算；100 轮无进展时总费用量级。（2026-09-23 修正：L1 Snip / L2 Micro 已移除，不再是预算项）
2. 无工具循环检测：模型卡在重复调用时（如反复 read_file 同名文件）loop 是否只有 100 轮硬顶；CC/pi 有无 stall/循环检测。
3. compact 失败面：`summarizeHistory` 抛错（上抛崩进程? 之前 04 关联）、压缩后仍超限（reactive compact 一次后 abort，CC 会降 max_tokens）。
4. 对照 `docs/research/claude-code-error-recovery.md`：CC 有而本项目无的（流停滞看门狗、部分输出保留、降 max_tokens、无限重试 watchidoog）哪些应进修复范围。

结论产出：失控面清单（含费用量级估算）+ 建议防护项（不实施）。

## ADR 边界

ADR-0007 已收缩恢复机制（删 fallback、重试对齐 pi retry settings），"恢复语义基准 = pi"。
结论请分两出口：
- **哲学内解**：跨轮预算、工具循环检测等新增防护机制（不与任何 ADR 冲突）
- **哲学外解**：引入 CC 恢复机制（retry watchdog / 降 max_tokens / 部分输出保留 / 流停滞看门狗）
  = 恢复哲学基准从 pi 漂向 CC，需 ADR 重审（决策票裁决时定）

