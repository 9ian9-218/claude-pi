# claude-pi

类 Claude Code 架构的 TypeScript Agent 运行时——Python 版 [Claude-Code-simple](https://github.com/z9ian9/myproject/Claude-Code-simple) 的全功能移植，叠加 pi 风格的树形会话管理（含断线恢复）、pi-tui 终端界面与可扩展接口体系。

> ⚠️ **安全警示**：扩展（`.agent/extensions/`、`~/.claude-pi/extensions/`、`-e`）执行任意代码。仅加载你信任的扩展。

## 特性

### 核心 Agent 引擎

- **ReAct Agent Loop**——注入 → 压缩 → 发送 → Hook → 执行工具的标准循环，单回合最多 100 轮工具调用
- **工具体系**——`run_bash` / `read_file` / `write_file` / `edit_file` / `glob` / `todo_write` / `load_skill`，外加任务看板、Subagent、Teammates、MCP 等内置工具
- **Hook 事件机制**——`UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `Stop` 等事件挂载点，用于拦截与扩展运行时行为
- **三级权限门控**——黑名单 → 规则 → 用户确认，危险操作在 TUI 中弹窗审批
- **错误恢复**——429/529 退避重试、fallback 模型、`max_tokens` 升级与续写
- **四层上下文压缩**——L3 Budget（超大结果落盘预览）、L1 Snip（裁剪中间消息）、L2 Micro（旧结果占位）、L4 Auto Compact（LLM 摘要，写 compaction entry）

### 树形会话

- **树形 JSONL 会话**——会话文件内以 entry 树组织，分支在原地进行，不创建新文件
- **fork / clone / resume**——从历史消息 fork 新会话、完整克隆会话、断线后从 leaf 恢复
- **断线恢复**——进程崩溃后重新打开会话文件并 resume，从上下文压缩检查点重建
- **多运行模式**——TTY 自动进入 TUI；`-p` 打印模式；`--mode json` 结构化输出（脚本/对拍接口）

### 多 Agent 协作

- **Subagent**——进程内一次性子 Agent，委派单个任务并返回结果
- **Teammates**——由 Lead 孵化的工作 Agent，独立异步 loop，邮箱通信，危险操作向 Lead 权限冒泡审批
- **后台任务**——`background: true` 的 bash 任务，结果以通知注入，带 stall 看门狗

### 记忆、任务与隔离

- **长期记忆**——Markdown 记忆文件，Stop Hook 异步提取，按相关性注入上下文
- **任务看板**——JSON 持久化任务列表，含依赖图与 claim/complete 生命周期
- **Git worktree 隔离**——认领任务时创建独立 worktree，操作局限其中，完成时自动清理
- **Skill**——`.agent/skills/` 下的 SKILL.md 按需加载注入系统提示

### 可扩展体系

- **扩展（Extension）**——TS 模块注册事件、工具、斜杠命令与 UI 交互；从三位置加载（`.agent/extensions/`、`~/.claude-pi/extensions/`、`-e`），支持 `/reload` 热重载
- **ctx.ui**——扩展可用的用户交互 API：confirm / select / input / notify / custom 组件，并可注册 entry 渲染器定制会话条目展示
- **appendEntry**——扩展向会话树追加自定义 entry，实现跨重启的状态持久化
- **MCP 集成**——标准 MCP client hub，工具以 `mcp__{server}__{tool}` 命名暴露；本地 server 将内置工具以 `mcp__local__{tool}` 呈现

### 模型与配置

- **与 pi 共享配置**——LLM 传输层基于 `@earendil-works/pi-ai`；模型/凭据/设置与 pi 共用全局目录 `~/.pi/agent/`（auth.json / models.json / settings.json），登录一次两边通用
- **多 Provider**——openai / anthropic / gemini / deepseek 等，模型以 `provider/model` 标识，支持自定义模型（Ollama / vLLM / 代理）
- **数据根跟随项目**——在任意项目运行，`.agent/`（会话/团队/记忆/任务/Skill/worktree/扩展）自动落在该项目下，不写用户目录

## 安装与快速开始

要求 Node.js ≥ 22.18（原生运行 TS，无需构建）。

```bash
npm install
npm link              # 全局安装命令 cpi
cpi                   # 交互模式（TTY 自动进入 TUI；管道/非 TTY 走行式 REPL）
```

## 命令行

| 命令 | 说明 |
| --- | --- |
| `cpi` | 交互模式，默认继续最近会话 |
| `cpi -p` | 打印模式：`echo "任务" \| cpi -p` |
| `cpi --mode json` | 结构化输出（对拍/脚本接口） |
| `cpi -c` | 继续最近会话（默认行为） |
| `cpi --session <id>` | 恢复指定会话 |
| `cpi --fork <id>` | fork 会话到新文件 |
| `cpi --no-session` | 临时会话（不落盘） |

TUI 内可用斜杠命令：`/tree`（会话树）、`/fork`、`/clone`、`/resume`、`/new`、`/name`、`/session`、`/login`、`/logout`、`/model`、`/settings`、`/reload`（扩展热重载）等，可扩展注册。

## 模型配置

优先使用与 pi 共享的全局配置（`PI_CODING_AGENT_DIR` 可覆盖 `~/.pi/agent/`）：

- `auth.json` — `/login` 保存的 API key / OAuth 凭据
- `models.json` — 自定义 provider/模型（Ollama / vLLM / 代理等）
- `settings.json` — retry 设置、defaultModel、enabledModels

也可直接用各 provider 的标准环境变量（如 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY`），或项目内 `.env` 文件。传输错误按 retry 设置自动重试。

## 项目结构

```
src/
├── cli.ts               # 入口与运行模式分发
├── agent-loop.ts        # ReAct 主循环
├── tool.ts              # 内置工具注册表与 Schema 校验
├── hook.ts              # Hook 事件机制
├── permission.ts        # 三级权限门控
├── compact.ts           # L1–L4 上下文压缩
├── error-recovery.ts    # 重试/fallback/续写
├── session-manager.ts   # 树形 JSONL 会话与 fork/clone/resume
├── memory.ts            # Markdown 长期记忆
├── tasks.ts             # 任务看板
├── worktree.ts          # Git worktree 隔离
├── background-task.ts   # 后台任务与 stall 看门狗
├── teammates/           # 队友孵化、邮箱、权限冒泡、Subagent 委派
├── tui/                 # pi-tui 终端界面（滚动区/弹窗/斜杠命令）
├── extensions/          # 扩展加载器与 ctx.ui API
└── mcp/                 # MCP hub 与本地 server
```

## 扩展开发

扩展是 TS 模块，通过 `registerExtension` 注册事件监听、工具、命令与 UI 交互：

```bash
# 全局扩展目录
mkdir -p ~/.claude-pi/extensions
```

参考示例：[examples/extensions/permission-gate.ts](./examples/extensions/permission-gate.ts)。修改后执行 `/reload` 即可热重载。

## 文档

- [CONTEXT.md](./CONTEXT.md) — 术语表（领域语言）
- [docs/adr/](./docs/adr/) — 架构决策记录

## 本地开发

```bash
npm install            # 安装依赖
npm run dev            # tsx 开发运行
npm run typecheck      # tsc --noEmit 类型检查
npm test               # vitest 全量测试
npx tsx scripts/parity/parity-runner.ts   # 与 Python 版 Claude-Code-simple 行为对拍
```

运行时数据（会话/团队/记忆/任务/Skill/worktree/扩展）存于项目内 `.agent/`（gitignored）。
