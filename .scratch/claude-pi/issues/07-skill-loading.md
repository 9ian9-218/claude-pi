# 07 — Skill 加载

**What to build:** 对话中按需加载能力：扫描 `.agent/skills/` 下 SKILL.md（frontmatter 解析与 Python 版一致），load_skill 工具按名称加载并注入系统提示，重复加载去重。

**Blocked by:** 02b 工具闭环

**Status:** ready-for-agent

- [ ] 扫描识别 `.agent/skills/` 下全部 skill 及描述
- [ ] load_skill 加载后 agent 可引用 skill 内容完成任务
- [ ] 重复加载不重复注入
- [ ] 加载逻辑的 vitest 测试绿灯
