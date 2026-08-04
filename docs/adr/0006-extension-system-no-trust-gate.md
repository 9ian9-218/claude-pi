# 扩展体系：全量开放接口，不引入信任门控

claude-pi 效仿 pi 开放扩展接口：事件钩子全集（session/agent/tool/model 生命周期 + 会话树操作事件）、`registerTool`、`registerCommand`、`ctx.ui`（confirm/select/input/notify/custom 组件）、`appendEntry`（custom entry 持久化）、自定义 TUI 组件/渲染器、`/reload` 热重载（jiti 动态加载 TS）。加载三位置：`.agent/extensions/`（项目内）、`~/.claude-pi/extensions/`（用户级）、`-e <path>`（CLI 临时）。

**不引入 pi 的 project_trust 门控**：扩展由用户主动放置，弹信任确认是摩擦；Python 版亦无 trust 机制（skills 直接加载），延续"机制不变"原则。安全边界以文档声明——扩展即任意代码执行，README 显著位置警示。

**Considered Options**: 引入 trust 确认——被否决（用户主动放置 + 既有机制无先例）；仅项目内加载——被否决（损失用户级扩展共享场景）。

**Consequences**: 扩展系统成为 claude-pi 的 API 门面，v1 即定全量接口避免 v2 破坏性变更；安全责任明确落在用户侧。
