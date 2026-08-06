# 07 — Footer + 状态指示器

**What to build:** 底部状态栏对齐 pi footer：模型标签 + cwd + 运行状态；agent-loop 运行时显示 Working spinner（pi-tui Loader），空闲显示 idle 提示；回合结束（onTurnEnd）驱动状态复位。

**Blocked by:** 02 主题系统、03 聊天区宿主

**Status:** ready-for-agent

- [ ] Footer 显示模型名、cwd、状态
- [ ] 生成期间 Working spinner 动画
- [ ] 状态在回合结束/中断后正确复位
- [ ] 渲染断言测试绿灯
