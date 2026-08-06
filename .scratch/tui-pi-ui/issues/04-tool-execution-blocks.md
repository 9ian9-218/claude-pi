# 04 — 工具执行块

**What to build:** 工具调用渲染为独立执行块：灰底 pending（工具名+参数）→ 绿底成功 / 红底失败（结果）。超长输出自动折叠为尾部若干可视行并显示跳过行数提示，Ctrl+O 切换展开/折叠。cli.ts 接 onToolEvent 驱动块状态。

**Blocked by:** 01 UI 事件通道、02 主题系统、03 聊天区宿主

**Status:** ready-for-agent

- [ ] 工具调用显示灰底块（pending），结果到达后变绿/红底
- [ ] 超长输出默认折叠（尾部 N 行 + "…N 行折叠"提示），Ctrl+O 展开
- [ ] 错误结果（isError）红底显示
- [ ] 渲染断言测试绿灯
