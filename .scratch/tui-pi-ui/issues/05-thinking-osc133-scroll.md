# 05 — thinking 块 + OSC133 + 滚动

**What to build:** 助手消息内 thinking 内容渲染为斜体灰块，默认折叠为 "Thinking..." 标签、Ctrl+T 展开/折叠（对齐 pi app.thinking.toggle）。用户/助手消息外包 OSC133 zone（终端消息跳转）。聊天区 PgUp/PgDn 滚动（补齐现有 Scrollback.scrollUp/scrollDown 未绑键的问题）。

**Blocked by:** 01 UI 事件通道、02 主题系统、03 聊天区宿主

**Status:** ready-for-agent

- [ ] thinking 流式渲染为斜体灰块，Ctrl+T 可折叠/展开
- [ ] 用户/助手消息带 OSC133 包裹标记
- [ ] PgUp/PgDn 滚动聊天区历史
- [ ] 渲染断言测试绿灯
