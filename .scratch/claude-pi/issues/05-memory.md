# 05 — 记忆

**What to build:** 长期记忆闭环：对话中的关键信息在 Stop Hook 异步提取为 Markdown 记忆文件（.agent/memory/），后续回合按相关性注入上下文（注入点与格式和 Python 版一致，含去重）。

**Blocked by:** 02a 对话闭环

**Status:** ready-for-agent

- [ ] 两轮对话后记忆文件落盘，内容含关键信息
- [ ] 下一轮对话中记忆按相关性注入且不重复注入
- [ ] 记忆文件格式与 Python 版字节级兼容
- [ ] 提取/注入路径的 vitest 测试绿灯
