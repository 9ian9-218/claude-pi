# claude-pi

类 Claude Code 架构的 TypeScript Agent 运行时——Python 版 [Claude-Code-simple](https://github.com/z9ian9/myproject/Claude-Code-simple) 的全功能移植，叠加 pi 风格的树形会话管理（含断线恢复）、pi-tui 终端界面、可扩展接口体系。

> ⚠️ **安全警示**：扩展（`.agent/extensions/`、`~/.claude-pi/extensions/`、`-e`）执行任意代码。仅加载你信任的扩展。

## 文档

- [PLAN.md](./PLAN.md) — 七阶段实施计划（工单化：`.scratch/claude-pi/issues/`，当前 frontier：01 已完成）
- [CONTEXT.md](./CONTEXT.md) — 术语表（领域语言）
- [docs/adr/](./docs/adr/) — 架构决策记录（6 项）

## 安装与使用（全局命令 `cpi`）

```bash
npm link              # 全局安装（Node >= 22.18，原生运行 TS，无需构建）
cpi                   # 交互模式（TTY 自动进入 TUI；管道/非 TTY 走行式 REPL）
cpi -p                # 打印模式：echo "任务" | cpi -p
cpi --mode json       # 结构化输出（对拍/脚本接口）
cpi -c                # 继续最近会话（默认行为）
cpi --session <id>    # 恢复指定会话
cpi --fork <id>       # fork 会话到新文件
cpi --no-session      # 临时会话（不落盘）
```

**数据根跟随当前目录**：在任意项目运行 `cpi`，`.agent/`（会话/团队/记忆/任务/Skill/worktree/扩展）自动落在该项目的 `.agent/` 下（`CLAUDE_PI_AGENT_ROOT` 可覆盖）。

**模型配置与 pi 共享**：LLM 传输层基于 `@earendil-works/pi-ai`（ADR-0007）。模型/凭据/设置走 pi 全局目录 `~/.pi/agent/`（auth.json / models.json / settings.json，`PI_CODING_AGENT_DIR` 可覆盖）——与 pi 登录一次两边通用；或用各 provider 标准环境变量（`ANTHROPIC_API_KEY` 等）。传输错误按 pi 的 retry settings 自动重试；Python 版的 `FALLBACK_MODEL_ID` / `OPENAI_*` env 已退役。

## 开发

```bash
npm install            # 安装依赖
npm run dev            # tsx 开发运行
npm run typecheck      # tsc --noEmit 类型检查
npm test               # vitest 全量测试
npx tsx scripts/parity/parity-runner.ts   # Python 版对拍
```

运行时数据（会话/团队/记忆/任务/Skill/worktree/扩展）存于项目内 `.agent/`（gitignored）。

## 状态

**全部 19 个工单已完成 ✅**（480/480 测试 + typecheck 全绿）

```
npm test        # 全量测试
npm run dev     # 交互（TTY → TUI；管道 → REPL）
npx tsx scripts/parity/parity-runner.ts   # Python 对拍
```

✅ **工单 01 仓库骨架**（Node 22 + TS + vitest + pi-tui@0.83.0 锁定 + `.agent/` 目录树 + .env 加载）
✅ **工单 02a 对话闭环**（openai SDK 流式客户端 + Agent Loop + Hook 注册表 + 占位 REPL + mock OpenAI 测试）
✅ **工单 02b 工具闭环**（Tool 抽象 + Schema 校验 + 权限黑名单/规则 + PreToolUse/PostToolUse + 6 工具 + strict 开关）
✅ **工单 03 错误恢复**（429/529 退避 + fallback + max_tokens 升级/续写 + reactive compact）
✅ **工单 04 压缩 L1–L3**（snip/micro/budget 落盘 + LLM 摘要，Python 行为对拍验证）
✅ **工单 05 记忆**（Markdown 长期记忆 + Stop 异步提取 + 相关性注入）
✅ **工单 06 后台任务**（子进程 + stall 看门狗 + 通知注入）
✅ **工单 07 Skill 加载**（扫描注册表 + load_skill 工具）
✅ **工单 08 任务看板 + worktree 隔离**（proper-lockfile + git worktree + 依赖图 + 工具集成）
✅ **工单 09 Subagent**（进程内子 agent + 工具集限制）
✅ **工单 10 Teammates 核心**（spawn/mailbox/poller/lifecycle + 输出队列 + 队友注入 + 5 工具）
✅ **工单 11 Teammates 进阶**（权限冒泡 + protocol request_id + autonomous idle）
✅ **工单 12 会话机制**（树形 JSONL 会话 + fork/clone/resume + 断线恢复 + L4 compaction entry）
✅ **工单 13 运行模式**（`-p` 打印 / `--mode json` 对拍接口，stdout 纯净）
✅ **工单 14 TUI 核心**（pi-tui 滚动区 + 输入 + 状态行 + 斜杠命令，TTY 自动呈现）
✅ **工单 15a TUI 权限弹窗**（overlay SelectList 允许/拒绝，接入 askUser）
✅ **工单 15b TUI 会话命令**（/tree /fork /clone /resume /name /session 选择器）
✅ **工单 15c TUI 通知与状态**（队友配色 + 后台通知 + worktree 指示器）
✅ **工单 16 扩展核心**（三位置加载 + 事件/工具/命令/appendEntry + /reload 热重载）
✅ **工单 17 扩展 UI**（ctx.ui confirm/select/input/notify/custom + entry 渲染器）
✅ **工单 18 对拍 + 冒烟**（Python REPL vs --mode json 双场景对拍，规范化比对）
✅ **工单 19 MCP 集成**（@modelcontextprotocol/sdk hub + 命名归一化 + 本地 server + mcp.json）

