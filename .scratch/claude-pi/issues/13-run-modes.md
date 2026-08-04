# 13 — 运行模式

**What to build:** 显式模式分派（ADR-0003）：默认交互（当前为占位 REPL，14 后为 TUI）；`-p` 打印模式（管道 stdin 合并进首轮提示，输出后退出）；`--mode json` 结构化输出（对拍测试接口）。cli.ts 负责模式分派与参数解析。

**Blocked by:** 02a 对话闭环

**Status:** ready-for-agent

- [ ] `echo "任务" | claude-pi -p` 完成一次对话并打印输出后退出
- [ ] `--mode json` 输出结构化结果（稳定 schema，供对拍脚本消费）
- [ ] 无参数启动进入交互模式
- [ ] 各模式的 vitest 测试绿灯（子进程驱动）
