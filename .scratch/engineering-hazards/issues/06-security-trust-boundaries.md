---
title: "研究：安全与信任边界（分发场景默认打开面）"
labels: ["wayfinder:research"]
parent: ../map.md
---

## Question

分发给别人安装后，哪些信任边界是**默认打开**的？实证逐项确认：

1. 扩展三位置加载（`.agent/extensions`、`~/.claude-pi/extensions`、`-e`）+ jiti 执行任意代码——README 已警示，但有哪些防误载机制（信任确认提示? 无提示?）。
2. MCP server 派生方式（`npx` 自动安装? 网络拉取供应链面）+ `headersHelper`/`apiKeyHelper` 脚本执行面。
3. hooks 任意 shell 命令的执行面（PreToolUse 等，配置即信任）。
4. 权限门控：黑名单→规则→用户确认之外，headless/自动模式下危险操作（bash 全量? 文件写?）的默认行为；路径穿越面（safePath 覆盖范围、`--path`/`--allowedTools` 等价物）。
5. 与 pi/CC 的默认安全姿态对比（CC 的 workspace trust、hook 审批）。

结论产出：默认打开面清单（含风险分级）+ 建议收敛项（不实施）。

## ADR 边界

ADR-0006 明确"不引入 trust 门控"（用户主动放置 + Python 无先例），安全责任在用户侧。
结论请分两出口：
- **哲学内解**：警示/文档强化、权限门控无头语义理清、路径检查补漏、MCP/hooks 配置面说明
- **哲学外解**：加信任确认/门控 = 推翻 ADR-0006，需先重审哲学（决策票裁决时定）

