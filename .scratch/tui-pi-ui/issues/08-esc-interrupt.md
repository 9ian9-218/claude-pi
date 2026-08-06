# 08 — Esc 中断生成

**What to build:** 生成中途按 Esc 中断当前回合：AbortController → LoopOptions.signal 全链路触发，助手块显示 "Operation aborted"（对齐 pi app.interrupt），不落盘、不退出；空闲时 Esc 无操作。退出入口为 /quit 与 Ctrl+D。

**Blocked by:** 01 UI 事件通道、03 聊天区宿主

**Status:** ready-for-agent

- [ ] busy 时 Esc 中断流式生成，助手块显示中止态
- [ ] 中断后会话无脏数据（无 error message 落盘）
- [ ] 空闲时 Esc 无副作用
- [ ] 按键注入测试绿灯
