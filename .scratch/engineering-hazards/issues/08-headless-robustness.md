---
title: "研究：无头模式健壮性（-p / --mode json / CI）"
labels: ["wayfinder:research"]
parent: ../map.md
---

## Question

分发后用户会拿 `-p` / `--mode json` 写脚本。实证无头模式的失败面：

1. 权限门控在无头模式 `askUser` 默认拒绝 → 危险操作**静默失败**（工具返回 error，模型可能继续乱走）；与 CC 的 headless 行为/退出码对比。
2. 重试在 CI 的失败面：retry 默认 3 次/2s，无 CC 的 `CLAUDE_CODE_RETRY_WATCHDOG` 式无限重试；429/529 风暴下脚本必然失败。
3. 输出契约：`--mode json` 结构稳定性（turns/final）、错误时退出码、`-p` 打印中断的半截输出（CC 已实现"保留已完成块"）。
4. parity 测试依赖 python3 的脆弱面（本机 ENOENT 已见）——CI 缺失下的回归保证。

结论产出：无头失败面清单（含退出码/输出契约建议）+ 修复候选（不实施）。
