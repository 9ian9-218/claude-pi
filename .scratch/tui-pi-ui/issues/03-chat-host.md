# 03 — 聊天区宿主：用户块 + 助手流式块

**What to build:** TuiApp 重构为 pi 式组件化聊天区（ChatContainer：消息组件列表 + 输入框 + footer 槽位），替代纯文本 Scrollback。用户消息渲染为背景色块（无 "User >" 前缀），助手回复流式原位渲染（无 "Model >" 前缀）。appendMessage 的标签前缀逻辑删除；cli.ts 的 onQuery 改由事件流驱动。随切片更新 app.test/ui-provider.test。

**Blocked by:** 01 UI 事件通道、02 主题系统

**Status:** ready-for-agent

- [ ] 用户消息 = 背景块 + Markdown，无任何角色前缀
- [ ] 助手消息流式 token 在原位增量渲染（不整屏重打）
- [ ] 布局：聊天区 + 输入行 + footer 槽位，resize 正确
- [ ] 系统消息（/help 等命令回显）有独立样式
- [ ] 组件渲染断言测试绿灯
