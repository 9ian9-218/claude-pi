---
title: "研究：会话文件 torn line 导致 resume 崩溃"
labels: ["wayfinder:research"]
parent: ../map.md
---

## Question

`SessionManager.open()` 对每行 `JSON.parse` **无 try/catch**——`kill -9` 落在 `appendFileSync` 中途会留下半行 JSON，resume 直接抛错（`SessionManager.list()` 有逐行容错，`open()` 没有）。实证：

1. `appendFileSync` 对小型写入的原子性；torn line 的现实概率（写盘 vs kill 窗口）。
2. open() 崩溃的失败模式：整进程崩、还是可被顶层捕获；`cpi --session <id>` 的表现。
3. 修复候选：open() 逐行容错跳过坏尾行 / 写入前先写临时文件再 rename / torn line 检测与截断——各自的代价与风险。

结论产出：失败模式确认 + 推荐修复方案与侵入面（不实施）。

## Resolution

已实施：`SessionManager.open()` 逐行 try/catch，坏行（kill -9 torn line）跳过，
恢复不崩溃；leaf 回到最后一个有效 entry。测试：尾行/中间坏行两用例。
地图携执行（用户授权），票关闭。
