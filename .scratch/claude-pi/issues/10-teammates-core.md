# 10 — Teammates 核心

**What to build:** 多 Agent 协作闭环：create_team / spawn_teammate / send_message / list_teammates 工具；Teammate 以独立异步 Agent Loop 运行（复用 09 的 runner）；邮箱为 JSON 数组文件（.agent/teams/，proper-lockfile 写锁，格式与 Python 版兼容）；Lead 侧轮询器消费队友消息注入上下文；跨 loop 输出经串行化输出队列（等价 console_lock）。

**Blocked by:** 09 Subagent, 02b 工具闭环

**Status:** ready-for-agent

- [ ] Lead 孵化 Teammate，通过 send_message 分配任务
- [ ] Teammate 在独立 loop 中执行，结果经邮箱回传并注入 Lead 上下文
- [ ] 队友消息在 REPL 中以 agent 配色区分显示
- [ ] 多 loop 并发输出不交错、不串行阻塞
- [ ] 邮箱文件格式与 Python 版兼容，并发写不损坏
- [ ] 协作流程的 vitest 测试绿灯
