# 02 — 主题系统

**What to build:** 移植 pi 的主题系统：dark/light 两个 JSON 主题文件（vars + colors），`theme.ts` 提供 fg/bg/bold/italic 等取色助手，Markdown 渲染从主题取色（替代当前硬编码 DEFAULT_MARKDOWN_THEME）。全部组件（消息块、工具块、弹窗、footer）从主题取色，dark 为默认。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] dark.json/light.json 含 pi 全套色板（userMessageBg/toolPendingBg/toolSuccessBg/toolErrorBg/thinkingText 等）
- [ ] theme.ts 提供 fg/bg 助手与 getMarkdownTheme()
- [ ] Scrollback/Markdown 改用主题色渲染
- [ ] 主题渲染断言测试绿灯
