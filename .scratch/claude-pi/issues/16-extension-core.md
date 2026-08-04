# 16 — 扩展核心

**What to build:** 开放扩展接口（ADR-0006）：jiti 动态加载三位置扩展（.agent/extensions/、~/.claude-pi/extensions/、-e <path>）；ExtensionAPI：事件全集（session 生命周期、会话树操作前/后、user_prompt_submit、pre/post_tool_use、stop、模型事件）、registerTool（动态加入工具注册表）、registerCommand（动态加入斜杠命令注册表）、appendEntry（custom entry 持久化）；/reload 热重载。无信任门控，README 警示。

**Blocked by:** 12 会话机制, 14 TUI 核心, 02b 工具闭环

**Status:** ready-for-agent

- [ ] 三位置扩展加载成功，事件钩子按生命周期触发
- [ ] 扩展注册的工具可被 agent 调用
- [ ] 扩展注册的斜杠命令可执行
- [ ] appendEntry 写入 custom entry，重启后扩展可读取
- [ ] /reload 热重载生效（修改后重载即生效）
- [ ] 示例扩展（权限门/路径保护/git checkpoint）可用
- [ ] 扩展 API 的 vitest 测试绿灯
