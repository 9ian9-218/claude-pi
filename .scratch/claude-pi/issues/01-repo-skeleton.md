# 01 — 仓库骨架

**What to build:** 让 claude-pi 有一个可运行、可测试、可提交的开发底座：Node 22 + TypeScript 工程初始化，tsx 开发运行、tsc 构建、vitest 测试跑通；pi-tui 锁定版本并验证能在 TTY 渲染一个最小组件；`.agent/` 数据根目录树（sessions/teams/memory/tasks/skills/worktrees/extensions）随启动创建；`.env` 加载生效。开发者 clone 后一条命令即可进入可开发状态。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] `npm test` 绿灯（含一个真实断言的最小测试）
- [ ] tsx 启动入口可运行并打印版本信息
- [ ] pi-tui 最小组件在 TTY 冒烟渲染成功（锁版本 @earendil-works/pi-tui@0.83.0）
- [ ] `.agent/` 目录树自动创建；`.env.example` 与 Python 版环境变量名一致
- [ ] README 记录开发命令与结构
