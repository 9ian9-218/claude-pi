# 06 — 输入框 Editor + 自动补全

**What to build:** 输入框从 Input 升级为 pi-tui Editor（多行编辑），接入自动补全：斜杠命令（内置 + 扩展注册）+ /model 模型名，用 pi-tui fuzzyFilter。Ctrl+C 清空输入框、Ctrl+D 空输入时退出（对齐 pi app.clear / app.exit）。

**Blocked by:** 02 主题系统、03 聊天区宿主

**Status:** ready-for-agent

- [ ] 多行编辑可用（IME 中文输入正常）
- [ ] 输入 / 弹出命令补全列表，可键盘选择
- [ ] /model 子命令补全模型名
- [ ] Ctrl+C 清空、Ctrl+D 空输入退出
- [ ] 按键注入测试绿灯
