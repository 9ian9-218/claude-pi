# 17 — 扩展 UI

**What to build:** 扩展的用户交互面：ctx.ui（confirm / select / input / notify / custom 自定义组件）；扩展可注册自定义 entry/消息渲染器（TUI 中按 customType 渲染）。

**Blocked by:** 16 扩展核心, 14 TUI 核心

**Status:** ready-for-agent

- [ ] 扩展调用 ctx.ui.confirm/select/input/notify，交互正确
- [ ] 扩展通过 ctx.ui.custom 注入自定义组件（键盘输入可用）
- [ ] 自定义 entry 按注册渲染器显示
- [ ] 交互与渲染的组件断言测试绿灯
