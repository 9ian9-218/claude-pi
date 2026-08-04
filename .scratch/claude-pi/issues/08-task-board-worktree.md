# 08 — 任务看板 + worktree 隔离

**What to build:** 持久化任务闭环：create/list/get/claim/complete 工具 + 依赖图 + JSON 看板（.agent/tasks/，格式与 Python 版兼容）；claim 时创建 git worktree（分支 `agent/task-<id>`，目录 .agent/worktrees/）并切换工作目录（AsyncLocalStorage），complete 时清理并恢复；git 不可用或工作区不干净时静默跳过。

**Blocked by:** 02b 工具闭环

**Status:** ready-for-agent

- [ ] 任务创建/列表/查询/认领/完成全流程可用，看板文件可跨重启读取
- [ ] claim 后文件操作局限在 worktree 内，主仓库不受影响
- [ ] complete 后 worktree 清理、工作目录恢复
- [ ] git 不可用时流程降级不报错
- [ ] 看板与 worktree 的 vitest 测试绿灯
