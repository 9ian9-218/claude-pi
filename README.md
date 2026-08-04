# claude-pi

类 Claude Code 架构的 TypeScript Agent 运行时——Python 版 [Claude-Code-simple](https://github.com/z9ian9/myproject/Claude-Code-simple) 的全功能移植，叠加 pi 风格的树形会话管理（含断线恢复）、pi-tui 终端界面、可扩展接口体系。

> ⚠️ **安全警示**：扩展（`.agent/extensions/`、`~/.claude-pi/extensions/`、`-e`）执行任意代码。仅加载你信任的扩展。

## 文档

- [PLAN.md](./PLAN.md) — 七阶段实施计划（工单化：`.scratch/claude-pi/issues/`，当前 frontier：01 已完成）
- [CONTEXT.md](./CONTEXT.md) — 术语表（领域语言）
- [docs/adr/](./docs/adr/) — 架构决策记录（6 项）

## 开发

```bash
npm install            # 安装依赖
npm run dev            # tsx 开发运行（当前：版本/banner 占位入口）
npm run typecheck      # tsc --noEmit 类型检查
npm test               # vitest 全量测试
npm run build          # tsc 构建到 dist/
```

运行时数据（会话/团队/记忆/任务/Skill/worktree/扩展）存于项目内 `.agent/`（gitignored）。

## 状态

✅ **工单 01 仓库骨架**（Node 22 + TS + vitest + pi-tui@0.83.0 锁定 + `.agent/` 目录树 + .env 加载）
✅ **工单 02a 对话闭环**（openai SDK 流式客户端 + Agent Loop + Hook 注册表 + 占位 REPL + mock OpenAI 测试）
✅ **工单 02b 工具闭环**（Tool 抽象 + Schema 校验 + 权限黑名单/规则 + PreToolUse/PostToolUse + 6 工具 + strict 开关）
⬜ 工单 03 错误恢复（frontier）

