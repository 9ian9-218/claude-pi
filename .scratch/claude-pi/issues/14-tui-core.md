# 14 — TUI 核心

**What to build:** pi-tui 全屏界面替换占位 REPL：Markdown 滚动区（流式渲染、长行换行）、底部输入行（IME 中文输入候选框定位正确）、状态行（模型名/Token 统计/工作目录）、斜杠命令注册表（/new /help 起步，可扩展）、Ctrl+C 退出、resize 处理。TUI 与 loop 通过事件/队列解耦（薄封装层，pi-tui 版本可升级）。

**Blocked by:** 02b 工具闭环

**Status:** ready-for-agent

- [ ] 完整对话在 TUI 中流式渲染（代码块/表格/长行）
- [ ] 中文输入法候选框位置正确
- [ ] 状态行实时反映模型与 Token 统计
- [ ] /new 清空会话（占位语义，12 后变为开新会话）、/help 可用
- [ ] 窗口 resize 与 Ctrl+C 行为正确
- [ ] 组件渲染断言测试（render(width) 输出、按键注入）绿灯
