---
title: "研究：数据卫生（.transcripts/ 未 gitignore、会话无清理）"
labels: ["wayfinder:research"]
parent: ../map.md
---

## Question

`.transcripts/`（当前 342 个文件）**不在 .gitignore**——工具输出含文件内容、可能含密钥/凭据，一旦 push 或发布泄露；`.agent/` 已忽略但发行包不含；会话/transcript 无保留与清理策略（CC 有 30 天 cleanupPeriodDays）。实证：

1. transcript 内容采样：确认含哪些敏感类内容（bash 输出、读到的文件、环境变量?）。
2. 泄露路径：`git add .` 提交、npm 发布（files 是否含?）、他人 clone 后读取。
3. 修复候选：gitignore 补 .transcripts/ + 默认关闭或隐私降级（截断/脱敏）+ 保留期清理策略（对齐 CC cleanupPeriodDays）——各自代价。

结论产出：泄露路径确认 + 建议改动集（不实施）。

## Resolution

已实施：.gitignore 补 `.transcripts/`（342 个含工具输出的转写文件不会进 git/发布包）。
会话清理保留期策略未做（属设计层，留 fog）。
