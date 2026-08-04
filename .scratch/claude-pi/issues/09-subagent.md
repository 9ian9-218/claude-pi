# 09 — Subagent

**What to build:** 进程内一次性委派：抽取共享的进程内 Agent runner（后续 Teammate 复用此结构），subagent_task 工具启动受限工具集的子 Agent 并回收结果；子 Agent 不可嵌套 spawn Teammate（工具集限制与 Python 版一致）。

**Blocked by:** 02b 工具闭环

**Status:** ready-for-agent

- [ ] 一次委派任务中，子 Agent 完成工作并返回结果给主 Agent
- [ ] 子 Agent 工具集受限（无嵌套 spawn 能力）
- [ ] runner 结构可被 Teammate 复用（无重复实现）
- [ ] 子 Agent 流程的 vitest 测试绿灯
