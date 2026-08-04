# 15b — TUI 会话命令

**What to build:** 会话树操作的可视化：/tree 导航（选择历史节点继续、切换分支、生成 branch_summary）、/fork（从历史 user message 开新会话，选中消息可编辑）、/clone（复制当前活动分支到新会话）、/resume（会话选择器）、/name、/session（会话信息展示）。全部基于 12 的 session-manager，TUI 只做选择器与展示。

**Blocked by:** 14 TUI 核心, 12 会话机制

**Status:** ready-for-agent

- [ ] /tree 选中历史节点后从此继续，可切回另一分支
- [ ] /fork 新会话从所选消息开始且消息可编辑
- [ ] /clone 生成完整历史的新会话文件
- [ ] /resume 选择器列出历史会话并可恢复
- [ ] 会话命令走查清单全过（含 branch_summary 显示）
