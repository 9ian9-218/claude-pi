# 02b — 工具闭环

**What to build:** 让 agent 能真正干活：Tool 抽象 + Schema 校验（含 strict 开关，env 与 Python 版一致）+ 权限门控前两级（黑名单 → 规则，用户确认级留给 15a）+ PreToolUse/PostToolUse 事件挂载（含内置 hook：schema 校验、权限检查、日志、大输出告警）。工具集：文件工具（read/write/edit/glob）+ run_bash（前台）+ todo_write。用户在终端下达"读取并解释代码"类指令，agent 完成工具调用并基于结果回复。

**Blocked by:** 02a 对话闭环

**Status:** ready-for-agent

- [ ] 工具 Schema 校验拒绝非法参数并返回可见错误
- [ ] 黑名单与规则级权限检查生效（危险命令被拦）
- [ ] PreToolUse/PostToolUse 事件按 Python 版语义触发
- [ ] 一次真实对话中完成 读文件→分析→写文件 的完整工具链
- [ ] mock 服务器驱动的工具调用测试绿灯
