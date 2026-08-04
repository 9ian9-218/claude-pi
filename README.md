# claude-pi

类 Claude Code 架构的 TypeScript Agent 运行时——Python 版 [Claude-Code-simple](https://github.com/z9ian9/myproject/Claude-Code-simple) 的全功能移植，叠加 pi 风格的树形会话管理（含断线恢复）、pi-tui 终端界面、可扩展接口体系。

> ⚠️ **安全警示**：扩展（`.agent/extensions/`、`~/.claude-pi/extensions/`、`-e`）执行任意代码。仅加载你信任的扩展。

## 文档

- [PLAN.md](./PLAN.md) — 七阶段实施计划（当前状态：规划完成，待 Phase 0）
- [CONTEXT.md](./CONTEXT.md) — 术语表（领域语言）
- [docs/adr/](./docs/adr/) — 架构决策记录（6 项）

## 状态

🚧 规划阶段——仓库骨架已建，代码未开始。决策均已与用户确认：Node 22 LTS + pi-tui + openai SDK + async-first + `.agent/` 数据根 + 树形会话 + 显式运行模式 + 扩展体系。
